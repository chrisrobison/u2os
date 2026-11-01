import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { recordAudit, updateAgentAction } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { buildOperations, OPS_LIMITS } from '../mcp/jobs/hunt/operations.js';
import { startServer } from './helpers/authed-server.js';

// #640: the Agent Operations view model and its read-only endpoint. Real SQLite (main db + hunt store) in a temp home.

const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-ops-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  t.after(() => { closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; fs.rmSync(dir, { recursive: true, force: true }); });
  return process.env.U2OS_VAULT;
}

function seed(vault) {
  const store = openStore(huntDbPath(vault));
  const add = (n, company, role) => { const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${n}#0`, company, role, rawText: company, applicationUrls: [], contactEmails: [], author: 'a' }); store.saveScore(job.id, SCORE); return job; };
  return { store, notion: add(1, 'Notion', 'Engineer'), acme: add(2, 'Acme', 'SRE') };
}

const audit = (over) => recordAudit({ requestedBy: 'job-autopilot', tool: 'jobs.send_application', arguments: {}, status: 'pending', autonomyLevel: 3, requiresApproval: true, ...over });

test('lists only job-hunt actions: awaiting approval, running, recent, failures, with the job named and no arguments or results', (t) => {
  const vault = home(t);
  const { store, notion, acme } = seed(vault);
  const db = getDb();
  const pending = audit({ arguments: { job_id: notion.id, secret: 'do-not-leak' } });
  const done = audit({ arguments: { job_id: acme.id }, status: 'executed', result: { ok: true, body: 'private text' } });
  const failed = audit({ tool: 'jobs.submit_application', arguments: { job_id: acme.id }, status: 'failed', result: { error: 'form changed\nunexpectedly' } });
  const running = audit({ arguments: { job_id: notion.id }, status: 'approved' });
  enqueueAction({ actionId: running.id, tool: running.tool, arguments: { job_id: notion.id } });
  audit({ requestedBy: 'user', tool: 'calendar.create', arguments: {}, status: 'pending' }); // not job hunt
  const ops = buildOperations({ db, store, autopilot: null, now: new Date('2026-10-28T00:00:00Z') });

  assert.equal(ops.autopilot, null);
  assert.deepEqual(ops.awaitingApproval.items.map((row) => [row.id, row.company, row.label]), [[pending.id, 'Notion', 'Send application email']]);
  assert.equal(ops.awaitingApproval.count, 1);
  assert.deepEqual(ops.running.items.map((row) => [row.id, row.status]), [[running.id, 'queued']]);
  assert.ok(ops.recent.some((row) => row.id === done.id && row.status === 'executed' && row.company === 'Acme'));
  assert.ok(!ops.recent.some((row) => row.id === pending.id), 'a pending approval is not "recent"');
  const failure = ops.failures.find((row) => row.id === failed.id);
  assert.equal(failure.message, 'form changed unexpectedly');
  assert.equal(failure.label, 'Submit application form');
  const text = JSON.stringify(ops);
  assert.ok(!text.includes('do-not-leak') && !text.includes('private text'), 'arguments and results never leave');
  assert.ok(!ops.recent.concat(ops.failures).some((row) => row.tool === 'calendar.create'));
  assert.equal(ops.lastActivity.lastActionAt, ops.recent[0].at);
  store.close();
});

test('owner sends recorded on the emails ledger are in scope; unknown job ids and malformed arguments are not trusted', (t) => {
  const vault = home(t);
  const { store, notion } = seed(vault);
  const sent = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: { to: 'x@y.example' }, status: 'pending', autonomyLevel: 3, requiresApproval: true });
  store.addEmail(notion.id, { kind: 'application', to: 'x@y.example', subject: 's', body: 'b', attachments: [], status: 'proposed', idempotencyKey: 'k1', actionId: sent.id });
  audit({ arguments: { job_id: '../../etc/passwd' } });
  audit({ arguments: { job_id: 'job_ffffffffffffffff' } });
  const ops = buildOperations({ db: getDb(), store });
  const byId = new Map(ops.awaitingApproval.items.map((row) => [row.id, row]));
  assert.equal(byId.get(sent.id).company, 'Notion');
  const others = ops.awaitingApproval.items.filter((row) => row.id !== sent.id);
  assert.equal(others.length, 2);
  assert.ok(others.every((row) => row.company === null && row.jobId === null), 'a bad or unknown job id names no job and links nowhere');
  store.close();
});

test('every list is capped and counts are exact; an autopilot report becomes the indicator, its errors and last-cycle facts', (t) => {
  const vault = home(t);
  const { store } = seed(vault);
  for (let i = 0; i < OPS_LIMITS.awaiting + 5; i++) audit({});
  const status = {
    config: { enabled: true, mode: 'live' }, error: null, running: true,
    lastReport: { startedAt: '2026-10-28T00:00:00.000Z', finishedAt: '2026-10-28T00:05:00.000Z', mode: 'live', actions: [{}, {}], needsYou: [{}], errors: ['score: model timeout', 'x'.repeat(500)] },
    lastChange: { at: '2026-10-27T00:00:00.000Z', channel: 'api', changes: [] },
  };
  const ops = buildOperations({ db: getDb(), store, autopilot: status });
  assert.equal(ops.awaitingApproval.items.length, OPS_LIMITS.awaiting);
  assert.equal(ops.awaitingApproval.count, OPS_LIMITS.awaiting + 5);
  assert.equal(ops.autopilot.mode, 'live');
  assert.equal(ops.autopilot.execution, 'running');
  assert.equal(ops.autopilot.cycleRunning, true);
  assert.deepEqual([ops.autopilot.lastCycle.actions, ops.autopilot.lastCycle.needsYou, ops.autopilot.lastCycle.errors], [2, 1, 2]);
  assert.equal(ops.autopilot.settingsChangedAt, '2026-10-27T00:00:00.000Z');
  assert.equal(ops.failures.filter((row) => row.source === 'autopilot').length, 2);
  assert.ok(ops.failures.every((row) => (row.message ?? '').length <= 200));
  assert.equal(ops.lastActivity.autopilotCycleAt, '2026-10-28T00:05:00.000Z');
  store.close();
});

test('with nothing recorded every field is empty or null, never invented', (t) => {
  const vault = home(t);
  const { store } = seed(vault);
  const ops = buildOperations({ db: getDb(), store, autopilot: { config: { enabled: false, mode: 'dry_run' }, error: null, running: false, lastReport: null } });
  assert.equal(ops.autopilot.mode, 'paused');
  assert.equal(ops.autopilot.lastCycle, null);
  assert.equal(ops.autopilot.lastRunAt, null);
  assert.deepEqual([ops.running.count, ops.awaitingApproval.count, ops.recent.length, ops.failures.length], [0, 0, 0, 0]);
  assert.deepEqual(ops.lastActivity, { autopilotCycleAt: null, lastActionAt: null, lastFailureAt: null });
  store.close();
});

test('GET /api/job-hunt/operations is read only: it changes no action, queue row, autopilot file or approval, and offers no other method', async (t) => {
  const vault = home(t);
  const handle = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => handle.server.close(resolve)));
  const { store, notion } = seed(vault);
  const pending = audit({ arguments: { job_id: notion.id } });
  const running = audit({ arguments: { job_id: notion.id }, status: 'approved' });
  enqueueAction({ actionId: running.id, tool: running.tool, arguments: { job_id: notion.id } });
  store.close();
  const autopilotFile = path.join(vault, 'job-hunt', 'autopilot.yaml');
  fs.writeFileSync(autopilotFile, 'enabled: true\nmode: dry_run\n');
  const base = `http://127.0.0.1:${handle.port}`;
  const snapshot = () => JSON.stringify([
    getDb().prepare('SELECT id, status, approved_by, updated_at, result FROM agent_actions ORDER BY id').all(),
    getDb().prepare('SELECT id, status, attempt_count, updated_at FROM action_queue ORDER BY id').all(),
    fs.readFileSync(autopilotFile, 'utf8'),
    getDb().prepare('SELECT COUNT(*) AS n FROM events').get().n,
  ]);
  const before = snapshot();
  const res = await fetch(`${base}/api/job-hunt/operations`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.autopilot.mode, 'dry_run');
  assert.equal(body.awaitingApproval.items[0].id, pending.id);
  assert.equal(body.running.items[0].id, running.id);
  await fetch(`${base}/api/job-hunt/operations`);
  assert.equal(snapshot(), before, 'reading operations changed nothing');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const attempt = await fetch(`${base}/api/job-hunt/operations`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, mode: 'live', approve: pending.id }) });
    assert.ok(attempt.status >= 400 && attempt.status < 500, `${method} is refused (${attempt.status})`);
  }
  assert.equal(snapshot(), before, 'no method on the operations path changed anything');
  updateAgentAction(pending.id, { status: 'rejected' }); // sanity: the snapshot would notice a change
  assert.notEqual(snapshot(), before);
});

test('the operations code has no write statements and the route registers GET only', () => {
  const source = fs.readFileSync(new URL('../mcp/jobs/hunt/operations.js', import.meta.url), 'utf8');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/.test(source.replace(/\/\/.*$/gm, '')), 'operations.js issues no write SQL');
  const routes = fs.readFileSync(new URL('../server/api/routes/job-hunt.js', import.meta.url), 'utf8');
  const operations = routes.split('\n').filter((line) => line.includes("'/api/job-hunt/operations'"));
  assert.deepEqual(operations.map((line) => /router\.(\w+)\(/.exec(line)[1]), ['get']);
});
