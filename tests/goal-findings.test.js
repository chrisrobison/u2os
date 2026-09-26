import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createGoalDraft, controlGoal, updateGoalDraft } from '../server/agent/goal-store.js';
import { listGoalFindings, reviewGoalFinding } from '../server/agent/goal-findings.js';
import { createRun, recordRunPlan } from '../server/agent/run-store.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { startServer } from './helpers/authed-server.js';

const nativeFetch = globalThis.fetch;
const draft = { objective: 'Research roles', completionCriteria: ['Review suitable roles'], constraints: [],
  permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 100, maxModelCalls: 20, maxTokens: 5000 } };
const item = { title: '<script>untrusted title</script>', url: 'https://example.test/role?id=2&utm_source=search', snippet: '<img src=x onerror=bad()> Remote role' };
let fixtureSequence = 0;
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-goal-findings-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}
function search(goal, ownerId, results, status = 'executed', mock = false) {
  const correlationId = `finding_fixture_${++fixtureSequence}`;
  const runId = createRun({ correlationId, actorId: ownerId, objective: goal.objective, goalId: goal.id });
  recordRunPlan(runId, { reasoning_summary: 'fixture', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] });
  const action = recordAudit({ requestedBy: ownerId, tool: 'web.search', arguments: { query: 'roles' }, status, correlationId,
    accountBinding: { providerId: 'brave-search', instanceId: 'account_fixture', label: 'Research account', apiKey: 'must not leak' } });
  getDb().prepare('UPDATE agent_actions SET result = ? WHERE id = ?').run(JSON.stringify({ query: 'roles', results, mock }), action.id);
  getDb().prepare('UPDATE agent_run_steps SET status = ?, action_id = ? WHERE run_id = ?').run(status, action.id, runId);
  getDb().prepare("UPDATE agent_runs SET status = 'completed' WHERE id = ?").run(runId);
  return { runId, actionId: action.id };
}

test('successful search links deduplicate across runs, with durable owner reviews and source provenance', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  const first = search(goal, 'owner', [item, { ...item, url: 'https://example.test/role?utm_campaign=two&id=2' }], 'executed', true);
  let list = listGoalFindings(goal.id, 'owner');
  assert.equal(list.findings.length, 1);
  const finding = list.findings[0];
  assert.equal(finding.url, 'https://example.test/role?id=2');
  assert.equal(finding.title, item.title);
  assert.equal(finding.sourceCount, 1);
  assert.equal(finding.sources[0].actionId, first.actionId);
  assert.equal(finding.sources[0].runId, first.runId);
  assert.equal(finding.sources[0].goalRevision, 1);
  assert.equal(finding.sources[0].mock, true);
  assert.equal(finding.sources[0].account.instanceId, 'account_fixture');
  assert.ok(!JSON.stringify(list).includes('must not leak'));
  const reviewed = reviewGoalFinding(goal.id, 'owner', finding.id, { reviewStatus: 'relevant', expectedRevision: 1, expectedGoalRevision: 1 });
  assert.equal(reviewed.reviewGoalRevision, 1);
  search(goal, 'owner', [item]);
  list = listGoalFindings(goal.id, 'owner');
  assert.equal(list.findings[0].sourceCount, 2);
  assert.equal(list.findings[0].reviewStatus, 'relevant');
  assert.equal(list.findings[0].revision, reviewed.revision);
  assert.equal(listGoalFindings(goal.id, 'owner').findings[0].sourceCount, 2, 'refresh never recounts the same action');
  controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  updateGoalDraft(goal.id, 'owner', { ...draft, constraints: ['Local only'], expectedRevision: 2 });
  closeAllForTests(); getDb();
  list = listGoalFindings(goal.id, 'owner');
  assert.equal(list.findings[0].reviewStatus, 'relevant');
  assert.equal(list.findings[0].reviewGoalRevision, 1, 'review does not silently transfer to revised criteria');
  assert.equal(list.findings[0].sources[0].goalRevision, 1);
  assert.throws(() => reviewGoalFinding(goal.id, 'owner', finding.id,
    { reviewStatus: 'relevant', expectedRevision: reviewed.revision, expectedGoalRevision: 1 }), { status: 409 });
}));

test('failed pending uncertain reads and unsafe URLs never become findings', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  for (const status of ['failed', 'pending', 'needs_attention']) search(goal, 'owner', [item], status);
  search(goal, 'owner', ['javascript:bad()', 'data:text/html,evil', 'https://user:pass@example.test/role',
    'https://example.test/role?access_token=secret', 'https://example.test/role#access_token=secret', 'not-a-url'].map((url) => ({ ...item, url })));
  const list = listGoalFindings(goal.id, 'owner');
  assert.equal(list.findings.length, 0);
  assert.equal(list.coverage.successfulSearches, 1);
  assert.equal(list.coverage.limitedActions, 1);
}));

test('finding reviews are exact-goal owner scoped, validated and revision safe', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  const other = createGoalDraft('owner', draft);
  search(goal, 'owner', [item]);
  const finding = listGoalFindings(goal.id, 'owner').findings[0];
  assert.throws(() => listGoalFindings(goal.id, 'other'), { status: 404 });
  assert.throws(() => reviewGoalFinding(goal.id, 'other', finding.id, { reviewStatus: 'relevant', expectedRevision: 1, expectedGoalRevision: 1 }), { status: 404 });
  assert.throws(() => reviewGoalFinding(other.id, 'owner', finding.id, { reviewStatus: 'relevant', expectedRevision: 1, expectedGoalRevision: 1 }), { status: 404 });
  assert.throws(() => reviewGoalFinding(goal.id, 'owner', finding.id, { reviewStatus: 'established_fact', expectedRevision: 1, expectedGoalRevision: 1 }), { status: 400 });
  reviewGoalFinding(goal.id, 'owner', finding.id, { reviewStatus: 'dismissed', expectedRevision: 1, expectedGoalRevision: 1 });
  assert.throws(() => reviewGoalFinding(goal.id, 'owner', finding.id, { reviewStatus: 'relevant', expectedRevision: 1, expectedGoalRevision: 1 }), { status: 409 });
  assert.equal(listGoalFindings(goal.id, 'owner').findings[0].reviewStatus, 'dismissed');
}));

test('indexing limits are explicit and old-schema migration preserves persisted evidence', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  for (let index = 0; index < 21; index++) search(goal, 'owner', [item]);
  getDb().exec('DROP TABLE goal_finding_sources; DROP TABLE goal_finding_index; DROP TABLE goal_findings');
  closeAllForTests(); getDb();
  let list = listGoalFindings(goal.id, 'owner', 10000);
  assert.equal(list.coverage.pendingActions, 1);
  assert.equal(list.findings[0].sourceCount, 20);
  list = listGoalFindings(goal.id, 'owner');
  assert.equal(list.coverage.pendingActions, 0);
  assert.equal(list.findings[0].sourceCount, 21);
  assert.equal(list.findings[0].sources.length, 5);
  search(goal, 'owner', Array.from({ length: 31 }, (_, index) => ({ ...item, url: `https://example.test/role/${index}` })));
  search(goal, 'owner', [{ ...item, snippet: 'x'.repeat(100001) }]);
  list = listGoalFindings(goal.id, 'owner', 1);
  assert.equal(list.findings.length, 1);
  assert.equal(list.coverage.totalFindings, 31);
  assert.equal(list.coverage.limitedActions, 2);
  assert.notEqual(listGoalFindings(goal.id, 'owner', 1, 1).findings[0].id, list.findings[0].id);
}));

test('finding API requires owner auth and uses no-store for listing and review', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const goal = await (await fetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })).json();
    const owner = getDb().prepare('SELECT owner_id FROM goals WHERE id = ?').get(goal.id).owner_id;
    search(goal, owner, [item]);
    assert.equal((await nativeFetch(`${base}/api/goals/${goal.id}/findings`)).status, 401);
    const result = await fetch(`${base}/api/goals/${goal.id}/findings`);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const finding = (await result.json()).findings[0];
    const reviewed = await fetch(`${base}/api/goals/${goal.id}/findings/${finding.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewStatus: 'relevant', expectedRevision: 1, expectedGoalRevision: 1 }) });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.headers.get('cache-control'), 'no-store');
    assert.equal((await reviewed.json()).reviewStatus, 'relevant');
  } finally { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));

test('projection storage failure rolls back all derived rows and permits safe retry', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  search(goal, 'owner', [item]);
  getDb().exec(`CREATE TRIGGER finding_fixture_failure BEFORE INSERT ON goal_finding_sources
    BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END`);
  assert.throws(() => listGoalFindings(goal.id, 'owner'), /fixture storage unavailable/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM goal_findings').get().count, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM goal_finding_index').get().count, 0);
  getDb().exec('DROP TRIGGER finding_fixture_failure');
  assert.equal(listGoalFindings(goal.id, 'owner').findings[0].sourceCount, 1);
}));
