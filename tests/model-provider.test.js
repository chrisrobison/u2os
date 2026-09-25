import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../server/agent/openai-compatible-provider.js';
import { AnthropicProvider } from '../server/agent/anthropic-provider.js';
import { validatePlan } from '../server/agent/plan-validator.js';
import { createToolRegistry } from '../server/tools/register-all.js';

const registry = createToolRegistry();
test('OpenAI-compatible provider returns a locally validated registered-tool plan', async () => {
  const fetchImpl = async (_url, request) => {
    const sent = JSON.parse(request.body); assert.equal(sent.model, 'local-model'); assert.ok(sent.messages[1].content.includes('tasks.create'));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reasoning_summary: 'Create it', actions: [{ tool: 'tasks.create', arguments: { title: 'Call Sarah' } }] }) } }] }), { status: 200 });
  };
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434', model: 'local-model', fetchImpl });
  const plan = await provider.plan({ toolRegistry: registry }, 'Please create a task');
  assert.equal(plan.actions[0].tool, 'tasks.create'); assert.equal(provider.id, 'openai-compatible:local-model');
});
test('plan validation rejects invented tools, missing required fields, and unknown arguments', () => {
  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [{ tool: 'shell.exec', arguments: {} }] }, registry), /Unknown tool/);
  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: {} }] }, registry), /missing required/);
  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: { title: 'x', policy: 'autonomous' } }] }, registry), /unknown argument/);
});
test('OpenAI-compatible provider includes retrieved_context (ContextAssembler output) in the request when present, and omits it when absent', async () => {
  let sent;
  const fetchImpl = async (_url, request) => {
    sent = JSON.parse(request.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reasoning_summary: '', actions: [] }) } }] }), { status: 200 });
  };
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434', model: 'local-model', fetchImpl });

  await provider.plan({ toolRegistry: registry }, 'anything');
  let payload = JSON.parse(sent.messages[1].content);
  assert.equal('retrieved_context' in payload, false);

  await provider.plan({ toolRegistry: registry, personalContext: { objective: 'x', relevantPeople: [] } }, 'anything');
  payload = JSON.parse(sent.messages[1].content);
  assert.deepEqual(payload.retrieved_context, { objective: 'x', relevantPeople: [] });
});

test('the shared planner system prompt tells the model retrieved_context is untrusted data, not instructions', async () => {
  const { PLANNER_SYSTEM_PROMPT } = await import('../server/agent/prompt-payload.js');
  assert.match(PLANNER_SYSTEM_PROMPT, /retrieved_context/);
  assert.match(PLANNER_SYSTEM_PROMPT, /untrusted/i);
  assert.match(PLANNER_SYSTEM_PROMPT, /never invent a tool/i);
});

test('provider failure is explicit and never silently executes or falls back', async () => {
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://local', model: 'm', fetchImpl: async () => new Response('', { status: 503 }) });
  await assert.rejects(provider.plan({ toolRegistry: registry }, 'anything'), /unavailable \(HTTP 503\)/);
});

test('OpenAI-compatible usage is reported before plan validation and malformed usage fails closed', async () => {
  const usage = [];
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://local', model: 'm', fetchImpl: async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 3 }, choices: [{ message: { content: '{bad' } }] }), { status: 200 }) });
  await assert.rejects(provider.plan({ toolRegistry: registry, onUsage: (item) => usage.push(item) }, 'x'), /invalid JSON/);
  assert.deepEqual(usage, [{ inputTokens: 9, outputTokens: 3, providerId: 'openai-compatible:m' }]);
  const invalid = new OpenAICompatibleProvider({ baseUrl: 'http://local', model: 'm', fetchImpl: async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: '9', completion_tokens: 3 } }), { status: 200 }) });
  await assert.rejects(invalid.plan({ toolRegistry: registry }, 'x'), { code: 'MODEL_USAGE_INVALID' });
});

// --- AnthropicProvider: the second, deliberately non-identical adapter ----
// (different auth header, different request/response envelope, no
// guaranteed JSON-only response mode) -- proves the ModelProvider
// abstraction is real rather than a reskin of the OpenAI-compatible shape.
test('Anthropic provider returns a locally validated registered-tool plan from its own request/response shape', async () => {
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.headers['x-api-key'], 'test-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    const sent = JSON.parse(request.body);
    assert.equal(sent.model, 'claude-test');
    assert.ok(sent.messages[0].content.includes('tasks.create'));
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ reasoning_summary: 'Create it', actions: [{ tool: 'tasks.create', arguments: { title: 'Call Sarah' } }] }) }] }),
      { status: 200 }
    );
  };
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-test', fetchImpl });
  const plan = await provider.plan({ toolRegistry: registry }, 'Please create a task');
  assert.equal(plan.actions[0].tool, 'tasks.create');
  assert.equal(provider.id, 'anthropic:claude-test');
});

test('Anthropic provider strips a markdown code fence before parsing, since the API has no guaranteed JSON-only mode', async () => {
  const fenced = '```json\n' + JSON.stringify({ reasoning_summary: 'ok', actions: [] }) + '\n```';
  const fetchImpl = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: fenced }] }), { status: 200 });
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-test', fetchImpl });
  const plan = await provider.plan({ toolRegistry: registry }, 'anything');
  assert.deepEqual(plan.actions, []);
});

test('Anthropic provider requires apiKey and model', () => {
  assert.throws(() => new AnthropicProvider({ model: 'claude-test' }), /requires apiKey and model/);
  assert.throws(() => new AnthropicProvider({ apiKey: 'k' }), /requires apiKey and model/);
});

test('Anthropic provider failure is explicit, same contract as the OpenAI-compatible provider', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-test', fetchImpl: async () => new Response('', { status: 503 }) });
  await assert.rejects(provider.plan({ toolRegistry: registry }, 'anything'), /unavailable \(HTTP 503\)/);
});

test('Anthropic usage is reported before plan validation; absent usage remains unknown', async () => {
  const usage = [];
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl: async () =>
    new Response(JSON.stringify({ usage: { input_tokens: 7, output_tokens: 2 }, content: [{ type: 'text', text: '{bad' }] }), { status: 200 }) });
  await assert.rejects(provider.plan({ toolRegistry: registry, onUsage: (item) => usage.push(item) }, 'x'), /invalid JSON/);
  assert.deepEqual(usage, [{ inputTokens: 7, outputTokens: 2, providerId: 'anthropic:m' }]);
  const missing = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl: async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: '{bad' }] }), { status: 200 }) });
  await assert.rejects(missing.plan({ toolRegistry: registry, onUsage: (item) => usage.push(item) }, 'x'), /invalid JSON/);
  assert.equal(usage.length, 1);
});

test('Anthropic provider output is validated by the exact same validatePlan() as every other provider -- an invented tool is rejected regardless of which provider proposed it', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ reasoning_summary: '', actions: [{ tool: 'shell.exec', arguments: {} }] }) }] }), { status: 200 });
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-test', fetchImpl });
  await assert.rejects(provider.plan({ toolRegistry: registry }, 'anything'), /Unknown tool/);
});
