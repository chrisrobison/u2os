import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { canonicalDataHome, acquireHomeGuard } from '../server/runtime/home-guard.js';
import { createRun } from '../server/agent/run-store.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt } from '../server/agent/action-queue-store.js';
import { Agent } from '../server/agent/agent.js';
import { AuthService } from '../server/security/auth.js';
import { DatabaseSync } from 'node:sqlite';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-runtime-'));
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = dir;
  const handles = [], children = [];
  const start = async (options = {}) => { const handle = await startServer({ port: 0, ...options }); handles.push(handle); return handle; };
  const child = async (home = dir) => {
    const processHandle = fork(fileURLToPath(new URL('./helpers/runtime-child.js', import.meta.url)), [], {
      env: { ...process.env, U2OS_HOME: home, U2OS_ACTION_QUEUE_TICK_MS: '600000', U2OS_MDNS: '0' },
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(processHandle); processHandle.stdout.resume(); processHandle.stderr.resume();
    const [message] = await once(processHandle, 'message');
    return { processHandle, message };
  };
  try { await run({ dir, handles, start, child }); }
  finally {
    for (const processHandle of children) if (processHandle.exitCode === null && processHandle.signalCode === null) {
      const exited = once(processHandle, 'exit'); processHandle.kill('SIGKILL'); await exited;
    }
    for (const handle of handles) await handle.shutdown();
    closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a duplicate or aliased home fails before application reconciliation; another home remains independent', () => fixture(async ({ dir, start, handles }) => {
  await start();
  const runId = createRun({ correlationId: 'fixture_live', actorId: 'owner', objective: 'Retain fixture working state' });
  const before = getDb().prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
  await assert.rejects(startServer({ port: 0 }), { code: 'HOME_IN_USE' });
  assert.deepEqual(getDb().prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId), before);
  const alias = path.join(dir, 'home-alias'); fs.symlinkSync(dir, alias, 'dir');
  process.env.U2OS_HOME = alias;
  await assert.rejects(startServer({ port: 0 }), { code: 'HOME_IN_USE' });
  process.env.U2OS_HOME = path.join(dir, 'other');
  const other = await startServer({ port: 0 }); handles.push(other);
  assert.ok(other.server.listening); process.env.U2OS_HOME = dir;
}));

test('early bootstrap failure releases ownership and clears prepared adapter resources', (t) => fixture(async ({ dir, start }) => {
  const timers = [], cleared = new Set();
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = interval(...args); timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared.add(timer); return clear(timer); });
  const fail = t.mock.method(AuthService.prototype, 'ensureOwnerEntityLink', () => { throw new Error('fixture bootstrap failure'); });
  await assert.rejects(startServer({ port: 0 }), /fixture bootstrap failure/);
  assert.ok(timers.length > 0 && timers.every((timer) => cleared.has(timer)));
  fail.mock.restore();
  const handle = await start(); assert.ok(handle.server.listening);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM entities').get().n, 0);
  assert.equal(canonicalDataHome(dir), fs.realpathSync(dir));
}));

test('the OS-backed guard rejects a different process and releases after process interruption without replaying uncertain effects', () => fixture(async ({ dir, child, start }) => {
  const first = await child(); assert.equal(first.message.kind, 'ready');
  const second = await child(); assert.equal(second.message.kind, 'failure'); assert.equal(second.message.code, 'HOME_IN_USE');
  assert.doesNotMatch(second.message.error, /fixture-secret|\.sqlite|u2os-runtime-/);
  // Explicit fault injection into isolated storage models an interrupted effect.
  const action = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { title: 'fixture', body: 'fixture' },
    status: 'approved', correlationId: 'fixture_interruption', policyDomain: 'notifications', policyRule: 'notifications.send:autonomous', requiresApproval: false });
  const queued = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments });
  leaseActionByActionId(action.id, { leaseOwner: 'fixture-interrupted', leaseMs: 60000 });
  beginActionAttempt({ queueId: queued.id, leaseOwner: 'fixture-interrupted' });
  getDb().prepare("UPDATE action_queue SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(queued.id);
  const exited = once(first.processHandle, 'exit'); first.processHandle.kill('SIGKILL'); await exited;
  const restarted = await start();
  const result = await restarted.agent.actionQueueWorker.processAction(action.id);
  assert.equal(result.errorClass, 'owner_attention_required');
  assert.match(result.error, /uncertain/);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM action_attempts WHERE queue_id = ?').get(queued.id).n, 1);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type = 'notification.sent'").get().n, 0);
}));

test('aborted HTTP clients do not release runtime ownership before their started handler finishes', (t) => fixture(async ({ start, child }) => {
  const entered = deferred(), release = deferred();
  t.mock.method(Agent.prototype, 'handleMessage', async () => { entered.resolve(); await release.promise; return { response: 'fixture finished' }; });
  const handle = await start();
  const origin = `http://127.0.0.1:${handle.port}`;
  const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'fixture-only correct horse battery staple' }) });
  const csrf = (await setup.json()).csrfToken;
  const controller = new AbortController();
  const request = fetch(`${origin}/api/agent/message`, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', origin, cookie: setup.headers.get('set-cookie').split(';')[0], 'x-u2os-csrf': csrf }, body: '{"text":"fixture delayed request"}' }).catch(() => null);
  await entered.promise; controller.abort(); await request;
  let closed = false; const shutdown = handle.shutdown(); assert.equal(handle.shutdown(), shutdown);
  shutdown.then(() => { closed = true; });
  const duplicate = await child(); assert.equal(duplicate.message.code, 'HOME_IN_USE');
  assert.equal(closed, false);
  let restarted = false; const next = start().then((value) => { restarted = true; return value; });
  await Promise.resolve(); assert.equal(restarted, false);
  release.resolve(); await shutdown; await next;
  assert.equal(closed, true); assert.equal(restarted, true);
}));

test('unknown guard files are never overwritten and symlinks are rejected', () => fixture(async ({ dir }) => {
  const file = path.join(dir, '.runtime-lock.sqlite');
  fs.writeFileSync(file, 'fixture-secret-owner-file');
  await assert.rejects(startServer({ port: 0 }), { code: 'HOME_GUARD_UNAVAILABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-secret-owner-file');
  fs.renameSync(file, path.join(dir, 'preserved-owner-file'));
  fs.symlinkSync(path.join(dir, 'preserved-owner-file'), file);
  assert.throws(() => acquireHomeGuard(dir), { code: 'HOME_GUARD_UNAVAILABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-secret-owner-file');
}));

test('a foreign SQLite file with a lookalike version cannot be adopted as a guard', () => fixture(async ({ dir }) => {
  const file = path.join(dir, '.runtime-lock.sqlite');
  const foreign = new DatabaseSync(file);
  foreign.exec('CREATE TABLE u2os_runtime_guard (version INTEGER NOT NULL, private_content TEXT); INSERT INTO u2os_runtime_guard VALUES (1, \'fixture-private-content\');');
  foreign.close();
  const before = fs.readFileSync(file);
  await assert.rejects(startServer({ port: 0 }), { code: 'HOME_GUARD_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(dir, 'config', 'installation.json')), false);
}));

test('an interrupted empty guard initialization completes without contaminating an explicit fresh demo', () => fixture(async ({ dir, start }) => {
  fs.writeFileSync(path.join(dir, '.runtime-lock.sqlite'), '', { mode: 0o600 });
  const handle = await start({ mode: 'demo' });
  assert.ok(handle.deviceRegistry.getAdapter('mock'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'installation.json'))).mode, 'demo');
  assert.ok(getDb().prepare('SELECT COUNT(*) n FROM entities').get().n > 1);
}));
