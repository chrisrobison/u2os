// Data-processing privacy policy (PLAN.md Phase 6): a separate gate from
// tool authorization, governing what DATA may reach which DESTINATION.
// These tests exist specifically to prove the headline scenario from the
// spec: a user can permit a local model to see sensitive content while
// forbidding that same content from ever reaching a remote provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataProcessingPolicy } from '../server/policy/data-processing-policy.js';
import { classifyProviderDestination } from '../server/agent/provider-destination.js';
import { filterPersonalContextForDestination } from '../server/agent/context-privacy-filter.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { OpenAICompatibleProvider } from '../server/agent/openai-compatible-provider.js';
import { AnthropicProvider } from '../server/agent/anthropic-provider.js';
import { Planner } from '../server/agent/planner.js';
import { MockEmbeddingProvider } from '../server/agent/embeddings/mock-embedding-provider.js';
import { OpenAICompatibleEmbeddingProvider } from '../server/agent/embeddings/openai-compatible-embedding-provider.js';
import { createToolRegistry } from '../server/tools/register-all.js';

function testPolicies() {
  return {
    public: { local_models: 'allow', remote_models: 'allow', external_tools: 'allow', local_ui: 'allow' },
    personal: { local_models: 'allow', remote_models: 'allow', external_tools: 'confirm', local_ui: 'allow' },
    private: { local_models: 'allow', remote_models: 'confirm', external_tools: 'confirm', local_ui: 'allow' },
    sensitive: { local_models: 'allow', remote_models: 'never', external_tools: 'never', local_ui: 'allow' },
  };
}

// --- DataProcessingPolicy.evaluate() ------------------------------------

test('sensitive data is allowed to a local model but never a remote one -- the headline scenario from the spec', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  assert.equal(policy.evaluate({ classification: 'sensitive', destination: 'local_model' }).decision, 'allow');
  assert.equal(policy.evaluate({ classification: 'sensitive', destination: 'configured_remote_model' }).decision, 'never');
});

test('private data requires confirmation before reaching a remote model, but is allowed locally', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  assert.equal(policy.evaluate({ classification: 'private', destination: 'configured_remote_model' }).decision, 'confirm');
  assert.equal(policy.evaluate({ classification: 'private', destination: 'local_model' }).decision, 'allow');
});

test('public and personal data may reach a remote model', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  assert.equal(policy.evaluate({ classification: 'public', destination: 'configured_remote_model' }).decision, 'allow');
  assert.equal(policy.evaluate({ classification: 'personal', destination: 'configured_remote_model' }).decision, 'allow');
});

test('an unrecognized classification fails safe to confirm, never to silent allow', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const result = policy.evaluate({ classification: 'top-secret', destination: 'configured_remote_model' });
  assert.equal(result.decision, 'confirm');
});

test('an unrecognized destination fails toward the strictest common category (remote_models) rather than assuming safety', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const result = policy.evaluate({ classification: 'sensitive', destination: 'some_new_destination_type' });
  assert.equal(result.decision, 'never');
});

test('a missing rule for a known classification/destination pair fails safe to confirm', () => {
  const policy = new DataProcessingPolicy({ policies: { personal: { local_models: 'allow' } } });
  const result = policy.evaluate({ classification: 'personal', destination: 'configured_remote_model' });
  assert.equal(result.decision, 'confirm');
  assert.match(result.rule, /missing/);
});

// --- classifyProviderDestination() ------------------------------------

test('loopback and private-network base URLs classify as local_model; public hosts classify as configured_remote_model', () => {
  assert.equal(classifyProviderDestination('http://127.0.0.1:11434'), 'local_model');
  assert.equal(classifyProviderDestination('http://localhost:11434'), 'local_model');
  assert.equal(classifyProviderDestination('http://192.168.1.50:11434'), 'local_model');
  assert.equal(classifyProviderDestination('http://10.0.0.5:11434'), 'local_model');
  assert.equal(classifyProviderDestination('https://api.openai.com'), 'configured_remote_model');
  assert.equal(classifyProviderDestination('https://api.anthropic.com'), 'configured_remote_model');
});

test('an explicit destination override always wins over the URL heuristic', () => {
  assert.equal(classifyProviderDestination('http://127.0.0.1:11434', 'configured_remote_model'), 'configured_remote_model');
});

test('real providers classify their own destination: Mock is always local, OpenAI-compatible/Anthropic follow the baseUrl heuristic', () => {
  assert.equal(new MockModelProvider().destination, 'local_model');
  assert.equal(new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'm' }).destination, 'local_model');
  assert.equal(new OpenAICompatibleProvider({ baseUrl: 'https://api.hosted-llm.example', model: 'm' }).destination, 'configured_remote_model');
  assert.equal(new AnthropicProvider({ apiKey: 'k', model: 'claude-test' }).destination, 'configured_remote_model');
  assert.equal(new MockEmbeddingProvider().destination, 'local_model');
  assert.equal(new OpenAICompatibleEmbeddingProvider({ baseUrl: 'http://localhost:11434', model: 'embed' }).destination, 'local_model');
  assert.equal(new OpenAICompatibleEmbeddingProvider({ baseUrl: 'https://embed.example', model: 'embed' }).destination, 'configured_remote_model');
});

// --- filterPersonalContextForDestination() ------------------------------

function personalContextWith(facts) {
  return { objective: 'x', relevantPeople: [{ id: 'p1', name: 'Sarah', matchedOn: 'x', facts, relationshipCount: 0 }], commitments: [], recentEvents: [], provenanceRefs: [], truncated: false };
}

test('a sensitive fact is omitted from context bound for a remote model, but kept for a local model', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const facts = [{ factId: 'f1', key: 'medical', value: 'has a penicillin allergy', classification: 'sensitive', confidence: 1, inferred: false }];

  const forRemote = filterPersonalContextForDestination(personalContextWith(facts), 'configured_remote_model', policy);
  assert.equal(forRemote.context.relevantPeople[0].facts.length, 0);
  assert.equal(forRemote.omitted.length, 1);
  assert.equal(forRemote.omitted[0].classification, 'sensitive');
  assert.equal(forRemote.omitted[0].decision, 'never');

  const forLocal = filterPersonalContextForDestination(personalContextWith(facts), 'local_model', policy);
  assert.equal(forLocal.context.relevantPeople[0].facts.length, 1);
  assert.equal(forLocal.omitted.length, 0);
});

test('standalone ranked facts are filtered and omitted provenance is pruned', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const personalContext = {
    objective: 'x', relevantPeople: [], commitments: [], recentEvents: [],
    relevantFacts: [
      { factId: 'restricted', entityId: 'project-private', classification: 'sensitive', value: 'secret' },
      { factId: 'allowed', entityId: 'project-public', classification: 'public', value: 'shareable' },
    ],
    provenanceRefs: [
      { type: 'entity', id: 'project-private' }, { type: 'fact', id: 'restricted' },
      { type: 'entity', id: 'project-public' }, { type: 'fact', id: 'allowed' },
    ],
    truncated: false,
  };
  const result = filterPersonalContextForDestination(personalContext, 'configured_remote_model', policy);
  assert.deepEqual(result.context.relevantFacts.map((fact) => fact.factId), ['allowed']);
  assert.deepEqual(result.context.provenanceRefs, [{ type: 'entity', id: 'project-public' }, { type: 'fact', id: 'allowed' }]);
  assert.ok(result.omitted.some((item) => item.type === 'fact' && item.id === 'restricted'));
});

test('a fact with no explicit classification defaults to "personal" for filtering purposes', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const facts = [{ factId: 'f1', key: 'note', value: 'likes coffee', confidence: 1, inferred: false }]; // no classification field
  const result = filterPersonalContextForDestination(personalContextWith(facts), 'configured_remote_model', policy);
  assert.equal(result.context.relevantPeople[0].facts.length, 1, 'personal data is allowed to remote models by default policy');
});

test('when nothing is omitted, the original context object is returned unchanged (no dataProcessingRestricted flag noise)', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const facts = [{ factId: 'f1', key: 'note', value: 'likes coffee', classification: 'public', confidence: 1, inferred: false }];
  const input = personalContextWith(facts);
  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);
  assert.equal(result.context, input);
  assert.equal(result.omitted.length, 0);
});

test('a sensitive person is dropped entirely from context bound for a remote model, but an allowed person is kept', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const input = {
    objective: 'x',
    relevantPeople: [
      { id: 'p1', name: 'Sensitive Sam', matchedOn: 'x', classification: 'sensitive', facts: [], relationshipCount: 0 },
      { id: 'p2', name: 'Public Pat', matchedOn: 'x', classification: 'public', facts: [], relationshipCount: 0 },
    ],
    commitments: [],
    recentEvents: [],
    provenanceRefs: [],
    truncated: false,
  };

  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);
  assert.equal(result.context.relevantPeople.length, 1);
  assert.equal(result.context.relevantPeople[0].id, 'p2');
  assert.equal(result.omitted.length, 1);
  assert.deepEqual(result.omitted[0], {
    type: 'person',
    id: 'p1',
    classification: 'sensitive',
    destination: 'configured_remote_model',
    decision: 'never',
    rule: 'sensitive.remote_models:never',
  });
});

test('an allowed person still has their own individually-sensitive facts filtered independently', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const input = {
    objective: 'x',
    relevantPeople: [
      {
        id: 'p1',
        name: 'Public Pat',
        matchedOn: 'x',
        classification: 'public',
        facts: [{ factId: 'f1', key: 'medical', value: 'has a penicillin allergy', classification: 'sensitive', confidence: 1, inferred: false }],
        relationshipCount: 0,
      },
    ],
    commitments: [],
    recentEvents: [],
    provenanceRefs: [],
    truncated: false,
  };

  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);
  assert.equal(result.context.relevantPeople.length, 1, 'the public person is kept');
  assert.equal(result.context.relevantPeople[0].facts.length, 0, 'their sensitive fact is still filtered');
  assert.equal(result.omitted.length, 1);
  assert.equal(result.omitted[0].type, 'fact');
});

test('a sensitive commitment is omitted from context bound for a remote model, but an allowed commitment is kept', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const input = {
    objective: 'x',
    relevantPeople: [],
    commitments: [
      { id: 'c1', description: 'discuss confidential merger terms', classification: 'sensitive', createdAt: '2024-01-01', confidence: 1, inferred: false },
      { id: 'c2', description: 'send meeting notes', classification: 'public', createdAt: '2024-01-01', confidence: 1, inferred: false },
    ],
    recentEvents: [],
    provenanceRefs: [],
    truncated: false,
  };

  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);
  assert.equal(result.context.commitments.length, 1);
  assert.equal(result.context.commitments[0].id, 'c2');
  assert.equal(result.omitted.length, 1);
  assert.equal(result.omitted[0].type, 'commitment');
  assert.equal(result.omitted[0].id, 'c1');
});

test('a sensitive recent event is omitted from context bound for a remote model, but an allowed event is kept', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const input = {
    objective: 'x',
    relevantPeople: [],
    commitments: [],
    recentEvents: [
      { eventId: 'e1', type: 'email.received', timestamp: '2024-01-01', summary: 'confidential legal notice', classification: 'sensitive' },
      { eventId: 'e2', type: 'calendar.created', timestamp: '2024-01-01', summary: 'team standup', classification: 'public' },
    ],
    provenanceRefs: [],
    truncated: false,
  };

  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);
  assert.equal(result.context.recentEvents.length, 1);
  assert.equal(result.context.recentEvents[0].eventId, 'e2');
  assert.equal(result.omitted.length, 1);
  assert.equal(result.omitted[0].type, 'event');
  assert.equal(result.omitted[0].id, 'e1');
});

test('a "confirm" decision (private data headed to a remote model) is treated as omit for every item type, not just facts -- there is no interactive confirmation path yet, so silently allowing through would leak private data', () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const input = {
    objective: 'x',
    relevantPeople: [
      { id: 'p1', name: 'Private Priya', matchedOn: 'x', classification: 'private', facts: [{ factId: 'f1', key: 'k', value: 'v', classification: 'private', confidence: 1, inferred: false }], relationshipCount: 0 },
    ],
    commitments: [
      { id: 'c1', description: 'a private commitment', classification: 'private', createdAt: '2024-01-01', confidence: 1, inferred: false },
    ],
    recentEvents: [
      { eventId: 'e1', type: 'email.received', timestamp: '2024-01-01', summary: 'a private email', classification: 'private' },
    ],
    provenanceRefs: [],
    truncated: false,
  };

  const result = filterPersonalContextForDestination(input, 'configured_remote_model', policy);

  // Everything private is omitted, not silently allowed through pending a
  // confirmation that never actually happens.
  assert.equal(result.context.relevantPeople.length, 0);
  assert.equal(result.context.commitments.length, 0);
  assert.equal(result.context.recentEvents.length, 0);
  assert.equal(result.omitted.length, 3, 'person, commitment, and event should each be recorded as omitted (the person\'s nested fact is never separately evaluated once the person itself is dropped)');
  for (const record of result.omitted) {
    assert.equal(record.decision, 'confirm');
  }
  assert.deepEqual(result.omitted.map((o) => o.type).sort(), ['commitment', 'event', 'person']);

  // The same private data reaches a local model untouched.
  const local = filterPersonalContextForDestination(input, 'local_model', policy);
  assert.equal(local.omitted.length, 0);
  assert.equal(local.context.relevantPeople.length, 1);
  assert.equal(local.context.commitments.length, 1);
  assert.equal(local.context.recentEvents.length, 1);
});

// --- End-to-end through Planner: the actual enforcement point ----------

test('END TO END: Planner withholds sensitive context from a remote provider and records what was withheld, but still lets planning proceed with the rest', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  let receivedPersonalContext = null;
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedPersonalContext = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };

  const events = [];
  const fakeEventBus = { publish: (e) => events.push(e) };

  const planner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  const facts = [
    { factId: 'f1', key: 'medical', value: 'has a penicillin allergy', classification: 'sensitive', confidence: 1, inferred: false },
    { factId: 'f2', key: 'preference', value: 'prefers morning meetings', classification: 'personal', confidence: 1, inferred: false },
  ];
  const planContext = {
    toolRegistry: registry,
    eventBus: fakeEventBus,
    correlationId: 'corr_1',
    actor: { type: 'user', id: 'user' },
    personalContext: personalContextWith(facts),
  };

  await planner.plan(planContext, 'anything');

  const remainingFacts = receivedPersonalContext.relevantPeople[0].facts;
  assert.equal(remainingFacts.length, 1);
  assert.equal(remainingFacts[0].factId, 'f2', 'the personal fact must still reach the remote provider');
  assert.ok(!remainingFacts.some((f) => f.classification === 'sensitive'), 'the sensitive fact must NEVER reach the remote provider');

  assert.deepEqual(planner.lastOmittedContext.map((o) => o.id), ['f1']);
  assert.ok(events.some((e) => e.type === 'agent.context_restricted'), 'withholding context must be auditable, never silent');
});

test('END TO END: the SAME sensitive fact reaches a LOCAL provider unfiltered', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  let receivedPersonalContext = null;
  const localProvider = {
    id: 'fake-local',
    destination: 'local_model',
    plan: async (context) => {
      receivedPersonalContext = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };

  const planner = new Planner({ modelProvider: localProvider, dataProcessingPolicy: policy });
  const facts = [{ factId: 'f1', key: 'medical', value: 'has a penicillin allergy', classification: 'sensitive', confidence: 1, inferred: false }];
  const planContext = {
    toolRegistry: registry,
    eventBus: { publish: () => {} },
    correlationId: 'corr_2',
    actor: { type: 'user', id: 'user' },
    personalContext: personalContextWith(facts),
  };

  await planner.plan(planContext, 'anything');

  assert.equal(receivedPersonalContext.relevantPeople[0].facts.length, 1);
  assert.equal(planner.lastOmittedContext.length, 0);
});

test('END TO END: a sensitive commitment never reaches a remote provider, but does reach a local one', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  const commitments = [
    { id: 'c1', description: 'discuss confidential merger terms', classification: 'sensitive', createdAt: '2024-01-01', confidence: 1, inferred: false },
    { id: 'c2', description: 'send meeting notes', classification: 'public', createdAt: '2024-01-01', confidence: 1, inferred: false },
  ];
  const personalContext = { objective: 'x', relevantPeople: [], commitments, recentEvents: [], provenanceRefs: [], truncated: false };

  let receivedRemote = null;
  const remoteEvents = [];
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedRemote = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const remotePlanner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  await remotePlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: (e) => remoteEvents.push(e) },
    correlationId: 'corr_commitment_remote',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedRemote.commitments.length, 1);
  assert.equal(receivedRemote.commitments[0].id, 'c2');
  assert.ok(!receivedRemote.commitments.some((c) => c.classification === 'sensitive'), 'the sensitive commitment must NEVER reach the remote provider');
  assert.deepEqual(remotePlanner.lastOmittedContext.map((o) => o.id), ['c1']);
  assert.ok(remoteEvents.some((e) => e.type === 'agent.context_restricted'), 'withholding a commitment must be auditable, never silent');

  let receivedLocal = null;
  const localProvider = {
    id: 'fake-local',
    destination: 'local_model',
    plan: async (context) => {
      receivedLocal = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const localPlanner = new Planner({ modelProvider: localProvider, dataProcessingPolicy: policy });
  await localPlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: () => {} },
    correlationId: 'corr_commitment_local',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedLocal.commitments.length, 2, 'the same sensitive commitment reaches a local provider unfiltered');
  assert.equal(localPlanner.lastOmittedContext.length, 0);
});

test('END TO END: a sensitive calendar-derived event summary never reaches a remote provider, but does reach a local one', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  const recentEvents = [
    { eventId: 'e1', type: 'calendar.event_added', timestamp: '2024-01-01', summary: 'Therapy session with Dr. Chen', classification: 'sensitive' },
    { eventId: 'e2', type: 'calendar.event_added', timestamp: '2024-01-01', summary: 'Team standup', classification: 'public' },
  ];
  const personalContext = { objective: 'x', relevantPeople: [], commitments: [], recentEvents, provenanceRefs: [], truncated: false };

  let receivedRemote = null;
  const remoteEvents = [];
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedRemote = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const remotePlanner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  await remotePlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: (e) => remoteEvents.push(e) },
    correlationId: 'corr_calendar_remote',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedRemote.recentEvents.length, 1);
  assert.equal(receivedRemote.recentEvents[0].eventId, 'e2');
  assert.ok(!receivedRemote.recentEvents.some((e) => e.classification === 'sensitive'), 'the sensitive calendar event must NEVER reach the remote provider');
  assert.deepEqual(remotePlanner.lastOmittedContext.map((o) => o.id), ['e1']);
  assert.ok(remoteEvents.some((e) => e.type === 'agent.context_restricted'), 'withholding a calendar-derived event must be auditable, never silent');

  let receivedLocal = null;
  const localProvider = {
    id: 'fake-local',
    destination: 'local_model',
    plan: async (context) => {
      receivedLocal = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const localPlanner = new Planner({ modelProvider: localProvider, dataProcessingPolicy: policy });
  await localPlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: () => {} },
    correlationId: 'corr_calendar_local',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedLocal.recentEvents.length, 2, 'the same sensitive calendar event reaches a local provider unfiltered');
  assert.equal(localPlanner.lastOmittedContext.length, 0);
});

test('END TO END: a sensitive email-derived event summary never reaches a remote provider, but does reach a local one', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  const recentEvents = [
    { eventId: 'e1', type: 'email.received', timestamp: '2024-01-01', summary: 'Re: your recent lab results (from dr.chen@clinic.example)', classification: 'sensitive' },
    { eventId: 'e2', type: 'email.received', timestamp: '2024-01-01', summary: 'Weekly newsletter (from news@example.com)', classification: 'public' },
  ];
  const personalContext = { objective: 'x', relevantPeople: [], commitments: [], recentEvents, provenanceRefs: [], truncated: false };

  let receivedRemote = null;
  const remoteEvents = [];
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedRemote = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const remotePlanner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  await remotePlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: (e) => remoteEvents.push(e) },
    correlationId: 'corr_email_remote',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedRemote.recentEvents.length, 1);
  assert.equal(receivedRemote.recentEvents[0].eventId, 'e2');
  assert.ok(!receivedRemote.recentEvents.some((e) => e.classification === 'sensitive'), 'the sensitive email-derived event must NEVER reach the remote provider');
  assert.deepEqual(remotePlanner.lastOmittedContext.map((o) => o.id), ['e1']);
  assert.ok(remoteEvents.some((e) => e.type === 'agent.context_restricted'), 'withholding an email-derived event must be auditable, never silent');

  let receivedLocal = null;
  const localProvider = {
    id: 'fake-local',
    destination: 'local_model',
    plan: async (context) => {
      receivedLocal = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const localPlanner = new Planner({ modelProvider: localProvider, dataProcessingPolicy: policy });
  await localPlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: () => {} },
    correlationId: 'corr_email_local',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedLocal.recentEvents.length, 2, 'the same sensitive email-derived event reaches a local provider unfiltered');
  assert.equal(localPlanner.lastOmittedContext.length, 0);
});

test('END TO END: a private commitment ("confirm" decision) is also omitted from a remote provider, proving the confirm-as-omit fail-safe holds through the full Planner path', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  const commitments = [
    { id: 'c1', description: 'a private commitment about a pending job offer', classification: 'private', createdAt: '2024-01-01', confidence: 1, inferred: false },
  ];
  const personalContext = { objective: 'x', relevantPeople: [], commitments, recentEvents: [], provenanceRefs: [], truncated: false };

  let receivedRemote = null;
  const remoteEvents = [];
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedRemote = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const remotePlanner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  await remotePlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: (e) => remoteEvents.push(e) },
    correlationId: 'corr_private_commitment_remote',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.equal(receivedRemote.commitments.length, 0, 'a "confirm" decision must still be treated as omit, not silently allowed through');
  assert.deepEqual(remotePlanner.lastOmittedContext.map((o) => o.id), ['c1']);
  assert.equal(remotePlanner.lastOmittedContext[0].decision, 'confirm');
  assert.ok(remoteEvents.some((e) => e.type === 'agent.context_restricted'), 'withholding a private commitment must be auditable, never silent');
});

test('END TO END: public commitments and events are NOT unnecessarily withheld from a remote provider, alongside sensitive ones of each that ARE correctly dropped in the same plan call', async () => {
  const policy = new DataProcessingPolicy({ policies: testPolicies() });
  const registry = createToolRegistry();

  const commitments = [
    { id: 'c1', description: 'discuss confidential merger terms', classification: 'sensitive', createdAt: '2024-01-01', confidence: 1, inferred: false },
    { id: 'c2', description: 'send meeting notes', classification: 'public', createdAt: '2024-01-01', confidence: 1, inferred: false },
  ];
  const recentEvents = [
    { eventId: 'e1', type: 'calendar.event_added', timestamp: '2024-01-01', summary: 'Therapy session with Dr. Chen', classification: 'sensitive' },
    { eventId: 'e2', type: 'calendar.event_added', timestamp: '2024-01-01', summary: 'Team standup', classification: 'public' },
  ];
  const personalContext = { objective: 'x', relevantPeople: [], commitments, recentEvents, provenanceRefs: [], truncated: false };

  let receivedRemote = null;
  const remoteEvents = [];
  const remoteProvider = {
    id: 'fake-remote',
    destination: 'configured_remote_model',
    plan: async (context) => {
      receivedRemote = context.personalContext;
      return { reasoning_summary: 'ok', actions: [] };
    },
  };
  const remotePlanner = new Planner({ modelProvider: remoteProvider, dataProcessingPolicy: policy });
  await remotePlanner.plan({
    toolRegistry: registry,
    eventBus: { publish: (e) => remoteEvents.push(e) },
    correlationId: 'corr_mixed_remote',
    actor: { type: 'user', id: 'user' },
    personalContext,
  }, 'anything');

  assert.deepEqual(receivedRemote.commitments.map((c) => c.id), ['c2'], 'the public commitment reaches the remote provider unfiltered');
  assert.deepEqual(receivedRemote.recentEvents.map((e) => e.eventId), ['e2'], 'the public event reaches the remote provider unfiltered');
  assert.deepEqual(remotePlanner.lastOmittedContext.map((o) => o.id).sort(), ['c1', 'e1']);
  assert.ok(remoteEvents.some((e) => e.type === 'agent.context_restricted'));
});
