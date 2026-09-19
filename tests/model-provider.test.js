import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../server/agent/openai-compatible-provider.js';
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
test('provider failure is explicit and never silently executes or falls back', async () => {
  const provider = new OpenAICompatibleProvider({ baseUrl: 'http://local', model: 'm', fetchImpl: async () => new Response('', { status: 503 }) });
  await assert.rejects(provider.plan({ toolRegistry: registry }, 'anything'), /unavailable \(HTTP 503\)/);
});
