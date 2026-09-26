import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createGoalDraft, getGoalDraft, listGoalDrafts, updateGoalDraft } from '../server/agent/goal-store.js';
import { createConversation, requireConversation } from '../server/agent/conversation-store.js';
import { startServer } from './helpers/authed-server.js';

const nativeFetch = globalThis.fetch;
const draft = {
  objective: 'Find suitable research roles',
  completionCriteria: ['Report three relevant open roles with links'],
  constraints: ['Remote or Bay Area only'],
  permittedScope: { domains: ['web'], consequentialActions: false },
  budgets: { maxRuns: 10, maxModelCalls: 20, maxTokens: 50_000 },
};

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-goal-drafts-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('draft goals are owner scoped, revision safe, and durable across additive migration', () => withHome(async () => {
  const conversationId = createConversation('owner');
  getDb().exec('DROP TABLE goals'); // old-schema fixture: preserve unrelated data
  closeAllForTests(); getDb();
  assert.equal(requireConversation(conversationId, 'owner'), conversationId);
  const goal = createGoalDraft('owner', draft);
  assert.equal(goal.status, 'draft');
  assert.equal(goal.executionEnabled, false);
  assert.equal(goal.nextWakeAt, null);
  assert.deepEqual(goal.relatedRuns, []);
  assert.equal(goal.spent.tokens, 0);
  assert.equal(listGoalDrafts('other').length, 0);
  assert.throws(() => getGoalDraft(goal.id, 'other'), { status: 404 });
  assert.throws(() => updateGoalDraft(goal.id, 'other', { ...draft, expectedRevision: 1 }), { status: 404 });
  const revised = updateGoalDraft(goal.id, 'owner', { ...draft, objective: 'Find research engineering roles', expectedRevision: 1 });
  assert.equal(revised.revision, 2);
  assert.throws(() => updateGoalDraft(goal.id, 'owner', { ...draft, expectedRevision: 1 }), { status: 409 });
  assert.equal(getGoalDraft(goal.id, 'owner').objective, 'Find research engineering roles');
  closeAllForTests(); getDb();
  assert.deepEqual(getGoalDraft(goal.id, 'owner'), revised);
  assert.equal(listGoalDrafts('owner')[0].id, goal.id);
  assert.equal(requireConversation(conversationId, 'owner'), conversationId);
}));

test('invalid drafts and stale edits never partially write', () => withHome(async () => {
  for (const input of [
    { ...draft, objective: '' },
    { ...draft, completionCriteria: [] },
    { ...draft, constraints: ['x'.repeat(301)] },
    { ...draft, permittedScope: { domains: ['shell'], consequentialActions: true } },
    { ...draft, permittedScope: { domains: ['web', 'web'], consequentialActions: false } },
    { ...draft, budgets: { ...draft.budgets, maxTokens: -1 } },
    { ...draft, extra: 'unknown' },
  ]) assert.throws(() => createGoalDraft('owner', input), { status: 400 });
  assert.equal(listGoalDrafts('owner').length, 0);
  const goal = createGoalDraft('owner', draft);
  assert.throws(() => updateGoalDraft(goal.id, 'owner', { ...draft, constraints: ['x'.repeat(301)], expectedRevision: 1 }), { status: 400 });
  assert.equal(getGoalDraft(goal.id, 'owner').revision, 1);
  assert.deepEqual(getGoalDraft(goal.id, 'owner').constraints, draft.constraints);
}));

test('goal API requires owner session and reports drafts without implied execution', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    assert.equal((await nativeFetch(`${base}/api/goals`)).status, 401);
    assert.equal((await nativeFetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })).status, 401);
    const created = await fetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
    assert.equal(created.status, 201);
    const goal = await created.json();
    assert.equal(goal.status, 'draft');
    assert.equal(goal.executionEnabled, false);
    assert.equal((await fetch(`${base}/api/goals/${goal.id}`)).status, 200);
    const listed = await fetch(`${base}/api/goals`);
    assert.deepEqual((await listed.json()).goals.map((item) => item.id), [goal.id]);
    const stale = await fetch(`${base}/api/goals/${goal.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, expectedRevision: 2 }) });
    assert.equal(stale.status, 409);
    const updated = await fetch(`${base}/api/goals/${goal.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, objective: 'New objective', expectedRevision: 1 }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).revision, 2);
    assert.equal((await fetch(`${base}/api/goals/missing`)).status, 404);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 0);
  } finally { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));
