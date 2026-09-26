import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { RECOVERY_FILE, assertExecutableHome } from '../server/backup/recovery-state.js';
import { reviewRecoveryWork, RECOVERY_ERROR_CLASS } from '../server/backup/recovery-quarantine.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt, requeueAction } from '../server/agent/action-queue-store.js';
import { createRun, recordRunPlan, getRun } from '../server/agent/run-store.js';
import { createGoalDraft } from '../server/agent/goal-store.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';
import { ActionQueueWorker } from '../server/agent/action-queue-worker.js';

const exec = promisify(execFile);
async function fixture(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-quarantine-')), previous = process.env.U2OS_HOME;
  try { await operation(await buildFixture(root)); }
  finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
}
async function buildFixture(root) {
  const source = path.join(root, 'source'), target = path.join(root, 'recovery'); process.env.U2OS_HOME = source;
  fs.mkdirSync(source); ensureInstallationMode(); const db = getDb();
  const goal = createGoalDraft('owner', { objective: 'fixture private research objective', completionCriteria: ['Fixture evidence'], constraints: [], permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 5, maxModelCalls: 10, maxTokens: 10000 } });
  const now = new Date().toISOString();
  db.prepare("UPDATE goals SET status='active' WHERE id=?").run(goal.id);
  const run = { id: createRun({ actorId: 'owner', objective: 'fixture private objective', correlationId: 'fixture_recovery', goalId: goal.id }) };
  db.prepare('UPDATE agent_runs SET model_call_count=2,input_tokens=123,output_tokens=45,continuation_after_step=0 WHERE id=?').run(run.id);
  const pending = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { title: 'fixture secret title', body: 'fixture private body' }, status: 'pending', requiresApproval: true, correlationId: 'fixture_pending' });
  const action = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { title: 'fixture consequential title', body: 'fixture private body' }, status: 'approved', requiresApproval: false, correlationId: 'fixture_recovery' });
  const queue = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments, approvalReference: 'fixture archived approval' });
  leaseActionByActionId(action.id, { leaseOwner: 'fixture_original', leaseMs: 60000 }); beginActionAttempt({ queueId: queue.id, leaseOwner: 'fixture_original' });
  recordRunPlan(run.id, { reasoning_summary: 'Fixture', continue: true, actions: [{ tool: action.tool, arguments: action.arguments, dependsOn: [] }, { tool: 'tasks.list', arguments: {}, dependsOn: [0] }] });
  db.prepare('UPDATE agent_run_steps SET action_id=? WHERE run_id=? AND step_index=0').run(action.id, run.id);
  recordRunPlan(run.id, { reasoning_summary: 'Fixture pending proposal', actions: [{ tool: pending.tool, arguments: pending.arguments }] });
  db.prepare('UPDATE agent_run_steps SET action_id=? WHERE run_id=? AND step_index=2').run(pending.id, run.id);
  db.prepare('UPDATE agent_runs SET continuation_after_step=2,continuation_claimed=1 WHERE id=?').run(run.id);
  db.prepare("UPDATE agent_run_steps SET status='waiting_dependency' WHERE run_id=? AND step_index=1").run(run.id);
  const completed = recordAudit({ requestedBy: 'owner', tool: 'tasks.list', arguments: {}, status: 'executed', requiresApproval: false, correlationId: 'fixture_completed' });
  db.prepare("UPDATE agent_actions SET result='{\"fixtureCompletedEvidence\":true}' WHERE id=?").run(completed.id);
  const repaired = enqueueAction({ actionId: completed.id, tool: completed.tool, arguments: {} });
  const completedRun = { id: createRun({ actorId: 'owner', objective: 'fixture completed historical objective', correlationId: 'fixture_completed_run' }) };
  db.prepare("UPDATE agent_runs SET status='completed',response='Fixture completed result' WHERE id=?").run(completedRun.id);
  db.prepare(`INSERT INTO triggers(id,name,kind,enabled,config,next_check_at,created_at,updated_at) VALUES('fixture_trigger','private name','timer',1,'{}',?,?,?)`).run(now, now, now);
  db.prepare(`INSERT INTO goal_wakes(id,goal_id,goal_revision,trigger_id,fire_at,created_at,updated_at) VALUES('fixture_wake',?,1,'fixture_trigger',?,?,?)`).run(goal.id, now, now, now);
  db.prepare(`INSERT INTO goal_research_schedules(id,goal_id,goal_revision,interval_hours,max_passes,wake_id,checked_at,created_at,updated_at)
    VALUES('fixture_series',?,1,24,2,'fixture_wake',?,?,?)`).run(goal.id, now, now, now);
  db.prepare("INSERT INTO owners(id,passphrase_hash,salt,scrypt_params,created_at) VALUES('owner','fixture hash','fixture salt','{}',?)").run(now);
  db.prepare("INSERT INTO sessions VALUES('fixture session hash','owner','fixture csrf',?,?,?)").run(now, now, now);
  const attempts = db.prepare('SELECT * FROM action_attempts').all(), completedBefore = db.prepare('SELECT * FROM agent_actions WHERE id=?').get(completed.id), runBefore = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(completedRun.id);
  const archive = path.join(root, 'fixture.tar.gz'); await createBackup({ dataDir: source, outputPath: archive });
  await restoreBackup({ archivePath: archive, dataDir: target }); closeAllForTests();
  return { root, source, target, archive, run, goal, pending, action, queue, repaired, attempts, completedBefore, runBefore };
}
function open(home) { return new DatabaseSync(path.join(home, 'db', 'u2os.sqlite')); }
function marker(home) { return JSON.parse(fs.readFileSync(path.join(home, RECOVERY_FILE))); }

test('preview returns counts only and leaves application database/marker/source/archive unchanged', () => fixture(async ({ source, target, archive }) => {
  const file = path.join(target, 'db', 'u2os.sqlite'), before = fs.readFileSync(file), original = fs.readFileSync(archive), state = fs.readFileSync(path.join(target, RECOVERY_FILE)), sourceBefore = fs.readFileSync(path.join(source, 'db', 'u2os.sqlite'));
  const preview = reviewRecoveryWork({ dataDir: target });
  assert.equal(preview.inactive, true); assert.equal(preview.counts.approvals, 2); assert.equal(preview.counts.heldQueueItems, 1); assert.equal(preview.counts.knownCompletedQueueRepairs, 1);
  assert.doesNotMatch(JSON.stringify(preview), /private|secret|archived approval|session hash|csrf|objective|body/);
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(path.join(target, RECOVERY_FILE)), state); assert.deepEqual(fs.readFileSync(archive), original); assert.deepEqual(fs.readFileSync(path.join(source, 'db', 'u2os.sqlite')), sourceBefore);
  assert.equal(fs.existsSync(`${file}-wal`), false);
}));

test('apply revokes archived authorization and runnable work, preserves evidence/budgets, and is idempotent', () => fixture(async ({ source, target, archive, run, goal, pending, action, queue, repaired, attempts, completedBefore, runBefore }) => {
  const original = fs.readFileSync(archive), sourceBefore = fs.readFileSync(path.join(source, 'db', 'u2os.sqlite'));
  const applied = reviewRecoveryWork({ dataDir: target, apply: true }); assert.equal(applied.inactive, true); assert.equal(marker(target).workQuarantine.id, applied.id);
  const db = open(target);
  try {
    assert.equal(db.prepare('SELECT status FROM agent_actions WHERE id=?').get(pending.id).status, 'cancelled');
    assert.equal(db.prepare('SELECT rejected_by FROM agent_actions WHERE id=?').get(action.id).rejected_by, 'system:recovery');
    const held = db.prepare('SELECT * FROM action_queue WHERE id=?').get(queue.id); assert.equal(held.status, 'failed'); assert.equal(held.error_class, RECOVERY_ERROR_CLASS); assert.equal(held.lease_owner, null); assert.equal(held.approval_reference, null);
    assert.equal(db.prepare('SELECT status FROM action_queue WHERE id=?').get(repaired.id).status, 'completed');
    assert.deepEqual(db.prepare('SELECT * FROM action_attempts').all(), attempts); assert.deepEqual(db.prepare('SELECT * FROM agent_actions WHERE id=?').get(completedBefore.id), completedBefore);
    assert.deepEqual(db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runBefore.id), runBefore);
    const stopped = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(run.id); assert.ok(stopped.cancel_requested_at); assert.equal(stopped.continuation_after_step, null); assert.equal(stopped.model_call_count, 2); assert.equal(stopped.input_tokens, 123); assert.equal(stopped.output_tokens, 45);
    assert.equal(db.prepare('SELECT status FROM goals WHERE id=?').get(goal.id).status, 'paused'); assert.equal(db.prepare('SELECT revision FROM goals WHERE id=?').get(goal.id).revision, 2);
    assert.equal(db.prepare('SELECT enabled FROM triggers').get().enabled, 0); assert.equal(db.prepare('SELECT status FROM goal_wakes').get().status, 'cancelled'); assert.equal(db.prepare('SELECT status FROM goal_research_schedules').get().status, 'cancelled'); assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.recovery_work_quarantined'").get().n, 1);
  } finally { db.close(); }
  const repeated = reviewRecoveryWork({ dataDir: target, apply: true }); assert.equal(repeated.id, applied.id); assert.equal(repeated.alreadyApplied, true);
  assert.deepEqual(Object.keys(reviewRecoveryWork({ dataDir: target })).sort(), ['alreadyApplied','counts','inactive']);
  assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' }); assert.deepEqual(fs.readFileSync(archive), original); assert.deepEqual(fs.readFileSync(path.join(source, 'db', 'u2os.sqlite')), sourceBefore);
  process.env.U2OS_HOME = target;
  assert.throws(() => requeueAction(queue.id), /fresh proposal/);
  const status = getRun(run.id); assert.equal(status.status, 'needs_attention'); assert.equal(status.steps[0].status, 'outcome_uncertain'); assert.equal(status.steps[1].status, 'cancelled'); assert.equal(status.steps[2].status, 'outcome_uncertain');
  let calls = 0; const worker = new ActionQueueWorker({ actionEvaluator: { resolve: () => { calls++; throw new Error('must not resolve'); } }, actionExecutor: {} });
  assert.equal(await worker.processNext(), null); assert.equal(calls, 0);
}));

test('normal homes, active aliases, incomplete/forged markers and identity mismatch are preserved and refused', () => fixture(async ({ root, source, target }) => {
  const original = fs.readFileSync(path.join(target, RECOVERY_FILE)); const data = marker(target);
  assert.throws(() => reviewRecoveryWork({ dataDir: source, apply: true }), /verified inactive/);
  const guard = acquireHomeGuard(target), alias = path.join(root, 'alias'); fs.symlinkSync(target, alias);
  try { assert.throws(() => reviewRecoveryWork({ dataDir: alias, apply: true }), { code: 'HOME_IN_USE' }); } finally { guard.release(); }
  for (const changed of [{ ...data, status: 'incomplete' }, { ...data, status: 'active' }, { ...data, installationId: 'fixture unrelated identity' }, { ...data, recoveryId: 'fixture invalid id' }, { ...data, workQuarantine: { id: 'fixture forged receipt' } }]) {
    fs.writeFileSync(path.join(target, RECOVERY_FILE), JSON.stringify(changed)); const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
    assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /refused/); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
  }
  fs.writeFileSync(path.join(target, RECOVERY_FILE), original);
}));

test('unsupported or executable database schema fails before operational changes', () => fixture(async ({ target }) => {
  const db = open(target); db.exec("CREATE TRIGGER fixture_bad AFTER UPDATE ON agent_actions BEGIN DELETE FROM goals; END;"); db.close();
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /executable database schema/); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
}));

test('custom expression indexes cannot execute archive-supplied expressions during quarantine', () => fixture(async ({ target }) => {
  const db = open(target); db.exec('CREATE INDEX fixture_expression ON agent_actions(length(arguments));'); db.close();
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /executable index expressions/); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
}));

test('unknown legacy schemas are not silently migrated during review', () => fixture(async ({ target }) => {
  const db = open(target); db.exec('DROP TABLE goal_research_schedules;'); db.close(); const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /schema is unsupported/); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
}));

test('a linked recovery database cannot redirect quarantine writes into the original', () => fixture(async ({ source, target }) => {
  const original = fs.readFileSync(path.join(source, 'db', 'u2os.sqlite'));
  fs.renameSync(path.join(target, 'db'), path.join(target, 'db-private')); fs.symlinkSync(path.join(source, 'db'), path.join(target, 'db'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /unavailable or linked/);
  assert.deepEqual(fs.readFileSync(path.join(source, 'db', 'u2os.sqlite')), original);
}));

test('transaction failure rolls back work and audit, retaining inactive state', (t) => fixture(async ({ target }) => {
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) { if (sql.startsWith('INSERT INTO events')) throw new Error('fixture secret database failure'); return prepare.call(this, sql); });
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /transaction was rolled back/); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
  assert.equal(marker(target).workQuarantine, undefined); assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
}));

test('checkpoint publication failure recovers without repeating database quarantine or audit', (t) => fixture(async ({ target, goal }) => {
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('fixture secret publication failure'); });
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /checkpoint publication failed/); assert.equal(marker(target).workQuarantine, undefined); failure.mock.restore();
  const retry = reviewRecoveryWork({ dataDir: target, apply: true }); assert.equal(retry.alreadyApplied, true); assert.equal(marker(target).workQuarantine.id, retry.id);
  const db = open(target); try { assert.equal(db.prepare('SELECT revision FROM goals WHERE id=?').get(goal.id).revision, 2); assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.recovery_work_quarantined'").get().n, 1); } finally { db.close(); }
}));

test('SIGKILL inside quarantine rolls back on explicit retry without duplicate checkpoint or revision', () => fixture(async ({ target, goal, attempts }) => {
  await assert.rejects(exec(process.execPath, [new URL('./helpers/quarantine-interrupted-child.js', import.meta.url).pathname], {
    env: { ...process.env, U2OS_HOME: target }, timeout: 10000,
  }), (error) => error.signal === 'SIGKILL');
  assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
  const applied = reviewRecoveryWork({ dataDir: target, apply: true }); assert.equal(applied.alreadyApplied, false);
  const db = open(target);
  try { assert.equal(db.prepare('SELECT revision FROM goals WHERE id=?').get(goal.id).revision, 2); assert.deepEqual(db.prepare('SELECT * FROM action_attempts').all(), attempts); assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.recovery_work_quarantined'").get().n, 1); }
  finally { db.close(); }
  assert.equal(reviewRecoveryWork({ dataDir: target, apply: true }).id, applied.id);
}));

test('stale checkpoint or subsequently rearmed work never grants permission or reports successful quarantine', () => fixture(async ({ target }) => {
  reviewRecoveryWork({ dataDir: target, apply: true }); let db = open(target);
  db.exec("UPDATE agent_runs SET status='needs_attention' WHERE cancel_requested_at IS NOT NULL"); db.close();
  // Grounded status recalculation can retain unknown outcomes on a stopped
  // run without making it runnable or invalidating its quarantine checkpoint.
  assert.equal(reviewRecoveryWork({ dataDir: target, apply: true }).alreadyApplied, true);
  db = open(target); db.exec('UPDATE triggers SET enabled=1'); db.close();
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), /no longer matches stopped work/); assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
}));

test('older recovery audit from the same installation does not satisfy the new restore checkpoint', () => fixture(async ({ target }) => {
  const db = open(target), now = new Date().toISOString();
  db.prepare("INSERT INTO events(id,type,timestamp,source,subject_id,data,created_at) VALUES('fixture_older','system.recovery_work_quarantined',?,'system:recovery',?,'{}',?)").run(now, randomUUID(), now); db.close();
  assert.equal(reviewRecoveryWork({ dataDir: target }).alreadyApplied, false);
  const applied = reviewRecoveryWork({ dataDir: target, apply: true }); assert.equal(applied.alreadyApplied, false); assert.equal(reviewRecoveryWork({ dataDir: target, apply: true }).id, applied.id);
}));

test('malformed checkpoint cannot leak private data or bypass current-state quarantine verification', () => fixture(async ({ target }) => {
  const db = open(target), now = new Date().toISOString();
  db.prepare("INSERT INTO events(id,type,timestamp,source,subject_id,data,created_at) VALUES('fixture_forged','system.recovery_work_quarantined',?,'system:recovery',?,?,?)").run(now, marker(target).recoveryId, JSON.stringify({ version: 1, id: 'fixture private recipient secret', counts: { secret: 'fixture sensitive payload' }, appliedAt: now }), now); db.close();
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.throws(() => reviewRecoveryWork({ dataDir: target, apply: true }), (error) => /checkpoint is invalid/.test(error.message) && !/recipient|sensitive payload/.test(error.message));
  assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before);
}));

test('CLI defaults to counts-only preview, applies only explicit flag and never prints stored private content', () => fixture(async ({ target }) => {
  const script = new URL('../server/backup/recovery-review-cli.js', import.meta.url).pathname, env = { ...process.env, U2OS_HOME: target };
  const preview = await exec(process.execPath, [script], { env, timeout: 10000 }); assert.match(preview.stdout, /Preview only/); assert.equal(marker(target).workQuarantine, undefined);
  const applied = await exec(process.execPath, [script, '--apply'], { env, timeout: 10000 }); assert.match(applied.stdout, /remains INACTIVE/); assert.doesNotMatch(preview.stdout + applied.stdout, /secret title|private body|objective|csrf|session hash/);
  await assert.rejects(exec(process.execPath, [script, '--force'], { env, timeout: 10000 }), (error) => /accepts only --apply/.test(error.stderr));
}));
