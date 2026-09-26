import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConversation, appendTurn, getConversationTurns, listConversations } from '../server/agent/conversation-store.js';
import { Agent } from '../server/agent/agent.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { startServer } from '../server/index.js';

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-conversations-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

function fixtureAgent(plan = async () => ({ reasoning_summary: 'Done', actions: [], response: 'Grounded reply' })) {
  const registry = new ToolRegistry();
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan },
    policyEngine: new PolicyEngine(), toolRegistry: registry, eventBus: new EventBus(getDb()) });
  agent.contextAssembler.assemble = async () => ({ toolRegistry: registry });
  return agent;
}

test('owner-scoped conversations keep turns separate and survive restart', () => withHome(async () => {
  const first = createConversation('owner-a');
  const second = createConversation('owner-a');
  const foreign = createConversation('owner-b');
  appendTurn({ conversationId: first, ownerId: 'owner-a', role: 'user', content: 'first secret' });
  appendTurn({ conversationId: second, ownerId: 'owner-a', role: 'user', content: 'second secret' });
  assert.deepEqual(getConversationTurns(first, 'owner-a').map((turn) => turn.content), ['first secret']);
  assert.deepEqual(getConversationTurns(second, 'owner-a').map((turn) => turn.content), ['second secret']);
  assert.deepEqual(listConversations('owner-a').map((row) => row.id).sort(), [first, second].sort());
  assert.deepEqual(listConversations('owner-b').map((row) => row.id), [foreign]);
  assert.throws(() => getConversationTurns(foreign, 'owner-a'), { status: 404 });
  assert.throws(() => appendTurn({ conversationId: foreign, ownerId: 'owner-a', role: 'user', content: 'leak' }), { status: 404 });
  closeAllForTests(); getDb();
  assert.equal(getConversationTurns(first, 'owner-a')[0].content, 'first secret');
  closeAllForTests(); getDb();
  assert.equal(getConversationTurns(first, 'owner-a').length, 1, 'migration is idempotent');
}));

test('bounded history returns newest turns with explicit truncation', () => withHome(async () => {
  const id = createConversation('owner');
  for (let index = 0; index < 55; index++) appendTurn({ conversationId: id, ownerId: 'owner', role: 'user', content: `${index}:${'x'.repeat(index === 54 ? 20_100 : 1)}` });
  const turns = getConversationTurns(id, 'owner', 1000);
  assert.equal(turns.length, 50);
  assert.equal(turns[0].content.startsWith('5:'), true);
  assert.equal(turns.at(-1).truncated, true);
  assert.equal(turns.at(-1).content.length, 20_000);
}));

test('legacy unowned transcript rows survive additive migration without being assigned to a new owner', () => withHome(async () => {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_messages (id, session_id, role, content, created_at)
    VALUES ('old_turn', 'old_session', 'user', 'existing personal text', ?)`).run(new Date().toISOString());
  closeAllForTests();
  const old = getDb();
  old.exec('DROP TABLE conversations');
  old.exec('ALTER TABLE conversation_messages DROP COLUMN run_id');
  old.exec('ALTER TABLE conversation_messages DROP COLUMN classification');
  closeAllForTests();
  const reopened = getDb();
  assert.equal(reopened.prepare("SELECT content FROM conversation_messages WHERE id = 'old_turn'").get().content, 'existing personal text');
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  assert.equal(reopened.prepare("SELECT run_id FROM conversation_messages WHERE id = 'old_turn'").get().run_id, null);
  assert.equal(reopened.prepare("SELECT classification FROM conversation_messages WHERE id = 'old_turn'").get().classification, 'private');
  const id = createConversation('owner');
  assert.deepEqual(getConversationTurns(id, 'owner'), []);
  closeAllForTests(); getDb();
  assert.equal(getDb().prepare("SELECT content FROM conversation_messages WHERE id = 'old_turn'").get().content, 'existing personal text');
}));

test('agent links successful and failed turns to runs without claiming failure as completion', () => withHome(async () => {
  const id = createConversation('owner');
  const agent = fixtureAgent();
  const result = await agent.handleMessage({ text: 'Hello', actorId: 'owner', conversationId: id });
  assert.equal(result.conversationId, id);
  assert.equal(result.conversationSaved, true);
  const turns = getConversationTurns(id, 'owner');
  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.deepEqual(turns.map((turn) => turn.runId), [result.runId, result.runId]);
  assert.equal(getDb().prepare('SELECT conversation_id FROM agent_runs WHERE id = ?').get(result.runId).conversation_id, id);
  await assert.rejects(fixtureAgent(async () => { throw new Error('fixture outage'); }).handleMessage({ text: 'Retry?', actorId: 'owner', conversationId: id }), /fixture outage/);
  assert.deepEqual(getConversationTurns(id, 'owner').slice(-2).map((turn) => turn.role), ['user', 'system']);
  assert.match(getConversationTurns(id, 'owner').at(-1).content, /No completion was claimed/);
  await assert.rejects(fixtureAgent().handleMessage({ text: 'x', actorId: 'other', conversationId: id }), { status: 404 });
}));

test('conversation routes require owner session and expose only bounded owner history', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    assert.equal((await fetch(`${base}/api/agent/conversations`)).status, 401);
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const csrf = (await setup.json()).csrfToken;
    const headers = { cookie, origin: base, 'x-u2os-csrf': csrf, 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/agent/conversations`, { method: 'POST', headers, body: '{}' });
    assert.equal(created.status, 201);
    const { conversationId } = await created.json();
    const unknown = await fetch(`${base}/api/agent/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'Do not plan', conversationId: 'missing' }) });
    assert.equal(unknown.status, 404);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 0);
    appendTurn({ conversationId, ownerId: getDb().prepare('SELECT id FROM owners LIMIT 1').get().id, role: 'user', content: 'private turn' });
    assert.equal((await fetch(`${base}/api/agent/conversations/${conversationId}/turns`)).status, 401);
    const history = await fetch(`${base}/api/agent/conversations/${conversationId}/turns?limit=1`, { headers: { cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).turns.map((turn) => turn.content), ['private turn']);
    assert.equal((await fetch(`${base}/api/agent/conversations/missing/turns`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/agent/conversations`, { headers: { cookie } })).status, 200);
  } finally { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));
