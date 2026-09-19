// PLAN.md Phase 8: the intelligent end-to-end vertical slice. Uses the REAL
// OpenAICompatibleProvider class (not a special test-only provider) pointed
// at a deterministic fake HTTP endpoint standing in for an LLM -- per the
// project's testing rules, no paid external API calls, but every other
// piece of the pipeline is the genuine article: ContextAssembler assembles
// real bounded personal context from the seeded SQLite memory, Planner
// applies the data-processing privacy filter, plan-validator.js validates
// the "model's" JSON, and every proposed action goes through the exact same
// ActionEvaluator/PolicyEngine/ActionExecutor/ApprovalManager pipeline a
// chat message from MockModelProvider would.
//
// The fake HTTP endpoints below are NOT hardcoded canned responses -- each
// one reads the actual `retrieved_context` it was sent and builds its
// answer FROM that data (which email is being referred to, what a
// contact's stored preference actually is), so a passing assertion is
// evidence the real retrieval pipeline supplied the right information, not
// a coincidence of two hardcoded strings matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { DataProcessingPolicy } from '../server/policy/data-processing-policy.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { OpenAICompatibleProvider } from '../server/agent/openai-compatible-provider.js';
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';
import { findEntities } from '../server/memory/entity-store.js';
import { recordFact } from '../server/memory/fact-store.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-intelligent-slice-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildAgent({ fetchImpl, sink }) {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const toolRegistry = createToolRegistry();
  const policyEngine = new PolicyEngine();
  const dataProcessingPolicy = new DataProcessingPolicy();
  const modelProvider = new OpenAICompatibleProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'local-test-model',
    fetchImpl: wrapWithCapture(fetchImpl, sink),
  });
  const agent = new Agent({ modelProvider, policyEngine, dataProcessingPolicy, toolRegistry, eventBus, ownerEntityId });
  return { db, eventBus, agent, ownerEntityId };
}

function wrapWithCapture(fetchImpl, sink) {
  return async (url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (sink) sink.push(payload);
    return fetchImpl(payload, url, request);
  };
}

function chatResponse(plan) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 });
}

test(
  'INTELLIGENT VERTICAL SLICE: "What\'s going on today, what should I pay attention to, and take care of anything routine that doesn\'t need me" -- ' +
    'inspects real retrieved context, autonomously handles the routine part, requests approval for the consequential part, and records everything',
  async () => {
    const dir = tempHome();
    try {
      const sink = [];
      const fetchImpl = async (payload) => {
        const ctx = payload.retrieved_context;
        // Genuinely reads the retrieved context to find the recruiter's
        // follow-up email rather than assuming it -- this is what makes the
        // test meaningful: if ContextAssembler didn't actually surface this
        // event, `recruiterEvent` would be undefined and the plan below
        // would be wrong in an assertion-visible way.
        const recruiterEvent = ctx.recentEvents.find((e) => e.type === 'email.received' && e.summary.includes('northwindtalent'));
        assert.ok(recruiterEvent, 'test setup sanity check: the seeded recruiter email must actually be in retrieved_context');
        const recruiterAddress = recruiterEvent.summary.match(/Email from ([^:]+):/)[1];

        return chatResponse({
          reasoning_summary: `Jamie Alvarez (recruiter) followed up asking for another call -- drafting a reply for your approval since outbound recruiter email needs confirmation. Sending a routine heads-up notification now since notifications are autonomous.`,
          actions: [
            { tool: 'notifications.send', arguments: { title: 'Morning summary', body: 'Recruiter follow-up needs a reply.', priority: 'normal' }, reason: 'Routine -- notifications are autonomous, does not need you.' },
            { tool: 'email.send', arguments: { to: recruiterAddress, subject: 'Re: Following up', body: 'Happy to chat again this week -- how does Thursday look?' }, reason: 'Consequential outbound email -- needs your approval.' },
          ],
          memoryCandidates: [{ content: 'Jamie Alvarez (recruiter) wants a follow-up call this week', confidence: 'medium' }],
        });
      };

      const { db, eventBus, agent } = buildAgent({ fetchImpl, sink });

      const result = await agent.handleMessage({
        text: "What's going on today, what should I pay attention to, and take care of anything routine that doesn't need me.",
        actorId: 'user',
      });

      // The trusted objective and the untrusted retrieved context were kept
      // separate all the way to the wire.
      assert.equal(sink[0].user_objective, "What's going on today, what should I pay attention to, and take care of anything routine that doesn't need me.");
      assert.ok(sink[0].retrieved_context, 'the real ContextAssembler output must have reached the provider');

      assert.equal(result.actions.length, 2);

      // 1. Routine: autonomous, no approval needed, already executed.
      const notify = result.actions[0];
      assert.equal(notify.tool, 'notifications.send');
      assert.equal(notify.status, 'executed');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'notification.sent'").get().n, 1);

      // 2. Consequential: requires the owner's explicit approval, NOT
      // autonomously sent -- proves policy evaluation ran independently of
      // whatever the model "wanted".
      const reply = result.actions[1];
      assert.equal(reply.tool, 'email.send');
      assert.equal(reply.status, 'pending');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'email.sent'").get().n, 0, 'the reply must NOT be sent before approval');

      // Memory candidate proposed and audited -- not silently promoted to
      // an established fact.
      assert.deepEqual(result.memoryCandidates, [{ content: 'Jamie Alvarez (recruiter) wants a follow-up call this week', confidence: 'medium' }]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.memory_candidate.proposed'").get().n, 1);

      // Approve the consequential action -> now it actually executes.
      const approved = await agent.approveAction(reply.id, 'user');
      assert.equal(approved.status, 'executed');
      const sentRow = db.prepare("SELECT * FROM events WHERE type = 'email.sent'").get();
      assert.ok(sentRow);
      const sentData = JSON.parse(sentRow.data);
      assert.ok(sentData.to.some((addr) => addr.includes('northwindtalent')));

      // Every step of the chain shares one correlationId, so the whole
      // decision is explainable/replayable end to end.
      const chain = db.prepare('SELECT type FROM events WHERE correlation_id = ? ORDER BY created_at').all(result.correlationId);
      const types = chain.map((r) => r.type);
      assert.ok(types.includes('agent.message.received'));
      assert.ok(types.includes('notification.sent'));
      assert.ok(types.includes('agent.action.proposed'));
      assert.ok(types.includes('agent.action.approved'));
      assert.ok(types.includes('email.sent'));

      void eventBus;
    } finally {
      cleanup(dir);
    }
  }
);

test('PERSISTENT MEMORY ACROSS TURNS: a fact established on "day one" is retrieved and USED on "day two" by a brand-new Agent instance sharing only the database', async () => {
  const dir = tempHome();
  try {
    // --- Day 1 -----------------------------------------------------------
    const day1Sink = [];
    const day1FetchImpl = async (payload) => {
      const dana = payload.retrieved_context.relevantPeople.find((p) => p.name === 'Dana Osei');
      assert.ok(dana, 'Dana must be surfaced in retrieved_context because the objective names her');
      return chatResponse({
        reasoning_summary: 'Noted the commitment to send Dana the budget summary; created a task for it.',
        actions: [{ tool: 'tasks.create', arguments: { title: 'Send Dana the budget summary', relatedEntityId: dana.id } }],
        memoryCandidates: [{ content: 'Dana prefers afternoon meetings', confidence: 'high' }],
      });
    };
    const { db, agent: day1Agent } = buildAgent({ fetchImpl: day1FetchImpl, sink: day1Sink });

    const day1 = await day1Agent.handleMessage({
      text: 'Remind me that Dana prefers afternoon meetings and I promised to send her the budget summary this week.',
      actorId: 'user',
    });
    assert.equal(day1.actions[0].status, 'executed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Send Dana the budget summary'").get().n, 1);
    assert.deepEqual(day1.memoryCandidates, [{ content: 'Dana prefers afternoon meetings', confidence: 'high' }]);

    // Confirming a memory candidate into an established fact is explicit
    // owner action -- Milestone 4's memory-confirmation API/UI doesn't
    // exist yet (see PLAN.md), so this stands in for it exactly the way a
    // future "confirm this candidate" endpoint would: a plain recordFact()
    // call with full provenance, never something the agent does to itself.
    const [dana] = findEntities({ type: 'Person', query: 'Dana Osei' });
    recordFact({
      entityId: dana.id,
      key: 'prefers_afternoon_meetings',
      value: true,
      source: 'user:confirmed_memory_candidate',
      confidence: 1.0,
      inferred: false,
    });

    // --- Day 2: a COMPLETELY NEW Agent (new ContextAssembler, Planner,
    // PolicyEngine, ToolRegistry, EventBus -- nothing but the SQLite file
    // is shared), simulating a server restart. -----------------------------
    const day2Sink = [];
    const day2FetchImpl = async (payload) => {
      const dana = payload.retrieved_context.relevantPeople.find((p) => p.name === 'Dana Osei');
      const preference = dana?.facts.find((f) => f.key === 'prefers_afternoon_meetings');
      assert.ok(preference, 'day 2 must retrieve the fact day 1 caused to be recorded, from a brand-new Agent instance');
      assert.equal(preference.source, 'user:confirmed_memory_candidate');
      assert.equal(preference.confidence, 1.0);

      // Genuinely uses the retrieved preference to pick a time, rather than
      // a coincidentally-matching hardcoded hour.
      const hour = preference.value === true ? 15 : 9;
      return chatResponse({
        reasoning_summary: `Scheduling the follow-up with Dana in the afternoon, per her recorded preference.`,
        actions: [
          {
            tool: 'calendar.create',
            arguments: { title: 'Follow-up with Dana', startAt: isoAtHour(hour, 0), endAt: isoAtHour(hour, 30), attendees: [{ name: 'Dana Osei' }] },
          },
        ],
      });
    };
    const { db: db2, agent: day2Agent } = buildAgent({ fetchImpl: day2FetchImpl, sink: day2Sink });
    assert.equal(db2, db, 'sanity check: same underlying SQLite connection -- only the Agent object is new');

    const day2 = await day2Agent.handleMessage({ text: 'Set up my follow-up with Dana.', actorId: 'user' });
    assert.equal(day2.actions[0].status, 'executed');

    const created = db.prepare("SELECT * FROM calendar_events WHERE title = 'Follow-up with Dana'").get();
    assert.ok(created);
    assert.equal(new Date(created.start_at).getHours(), 15, 'the meeting must land in the afternoon, honoring the fact recorded on day 1');
  } finally {
    cleanup(dir);
  }
});

function isoAtHour(hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + 3); // safely in the future regardless of when the test runs
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
