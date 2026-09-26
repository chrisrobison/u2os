import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createEntity } from '../server/memory/entity-store.js';
import { createRun } from '../server/agent/run-store.js';
import { createGoalDraft } from '../server/agent/goal-store.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt } from '../server/agent/action-queue-store.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { reviewRecoveryWork } from '../server/backup/recovery-quarantine.js';
import { reviewRecoveryConnectivity } from '../server/backup/recovery-connectivity.js';
import { compareRecoveryEvidence } from '../server/backup/recovery-compare.js';
import { assertExecutableHome, RECOVERY_FILE } from '../server/backup/recovery-state.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';

const exec = promisify(execFile), VALUE = 'private-comparison-fixture';
const open = (home) => new DatabaseSync(path.join(home, 'db', 'u2os.sqlite'));
async function fixture(operation, { connectivity = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-comparison-')), previous = process.env.U2OS_HOME;
  try {
    const source = path.join(root, 'original'), target = path.join(root, 'recovery'); process.env.U2OS_HOME = source;
    fs.mkdirSync(source); ensureInstallationMode(); const db = getDb(), now = new Date().toISOString();
    const entity = createEntity({ type: 'person', name: VALUE });
    db.prepare("INSERT INTO owners(id,entity_id,passphrase_hash,salt,scrypt_params,created_at) VALUES('owner',?,'fixture hash','fixture salt','{}',?)").run(entity.id, now);
    const goal = createGoalDraft('owner', { objective: VALUE, completionCriteria: [VALUE], constraints: [], permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 5, maxModelCalls: 10, maxTokens: 10000 } });
    db.prepare("UPDATE goals SET status='active' WHERE id=?").run(goal.id);
    const runId = createRun({ actorId: 'owner', objective: VALUE, correlationId: 'fixture_comparison', goalId: goal.id });
    db.prepare('UPDATE agent_runs SET model_call_count=1,metered_model_calls=1,input_tokens=100,output_tokens=20 WHERE id=?').run(runId);
    const action = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { body: VALUE }, status: 'approved', requiresApproval: false });
    const queue = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments }); leaseActionByActionId(action.id, { leaseOwner: 'fixture' }); const attempt = beginActionAttempt({ queueId: queue.id, leaseOwner: 'fixture' });
    writeEncryptedFile('notify-webhook', { webhookUrl: `https://notify.example.test/${VALUE}` });
    fs.writeFileSync(path.join(source, 'config', 'config.json'), JSON.stringify({ model: { provider: 'anthropic', model: VALUE } }));
    fs.mkdirSync(path.join(source, 'policies'), { recursive: true });
    for (const name of ['policies.yaml','data-processing.yaml']) fs.writeFileSync(path.join(source, 'policies', name), 'fixture: original\n');
    const archive = path.join(root, 'fixture.tar.gz'); await createBackup({ dataDir: source, outputPath: archive }); await restoreBackup({ archivePath: archive, dataDir: target }); closeAllForTests();
    reviewRecoveryWork({ dataDir: target, apply: true }); if (connectivity) reviewRecoveryConnectivity({ dataDir: target, apply: true });
    await operation({ root, source, target, archive, entity, goal, runId, action, queue, attempt });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
}
async function cleanComparison(source, target) {
  const make = fs.mkdtempSync, staged = [];
  fs.mkdtempSync = (...args) => { const dir = make(...args); if (String(args[0]).includes('u2os-recovery-compare-')) staged.push(dir); return dir; };
  try { return await compareRecoveryEvidence({ dataDir: target, originalDataDir: source }); }
  finally { fs.mkdtempSync = make; for (const dir of staged) assert.equal(fs.existsSync(dir), false, 'private comparison staging must be cleaned'); }
}

test('comparison is metadata-only/read-only and original in-flight evidence is not delivery proof', () => fixture(async ({ source, target }) => {
  const files = [path.join(source, 'db/u2os.sqlite'),path.join(target, 'db/u2os.sqlite'),path.join(target, RECOVERY_FILE),path.join(source, 'config/config.json'),path.join(source, 'credentials/notify-webhook.enc.json')];
  const bytes = files.map((file) => fs.readFileSync(file));
  const result = await cleanComparison(source, target);
  assert.equal(result.inactive, true); assert.equal(result.executionAuthorized, false); assert.equal(result.originalRetired, false); assert.equal(result.providerOutcomesVerified, false); assert.equal(result.resourceLedgerReconciled, false);
  assert.equal(result.installationMatched, true); assert.equal(result.ownerEntityMatched, true); assert.equal(result.ownerAuthenticationChanged, false);
  assert.deepEqual(result.policies, { authorizationChanged: false, dataProcessingChanged: false });
  assert.deepEqual(result.actions, { originalOnly: 0, recordedCompletionsBeyondSnapshot: 0, newOrChangedAttemptEvidence: 0, originalInFlightAttempts: 1 });
  assert.deepEqual(result.resources, { modelCallsBeyondSnapshot: 0, recordedInputTokensBeyondSnapshot: 0, recordedOutputTokensBeyondSnapshot: 0, originalRunsWithUnmeteredCalls: 0, monetaryCostAvailable: false, matchingRunsWithRegressedCounters: 0 });
  assert.doesNotMatch(JSON.stringify(result), /private-comparison|example\.test|fixture hash|fixture salt|owner"|entity_|goal_|run_|act_|queue_/);
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index])); assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
}));

test('committed WAL progress, recorded usage, owner rename/auth and policy/scope drift are observed without mutation', () => fixture(async ({ source, target, entity, goal, runId, action, attempt }) => {
  process.env.U2OS_HOME = source; const db = getDb(); db.exec('PRAGMA wal_autocheckpoint=0;');
  db.prepare("UPDATE agent_actions SET status='executed',result=? WHERE id=?").run(JSON.stringify({ privateResult: VALUE }), action.id);
  db.prepare("UPDATE action_attempts SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), attempt.id);
  const newAction = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { body: VALUE }, status: 'approved', requiresApproval: false });
  const newQueue = enqueueAction({ actionId: newAction.id, tool: newAction.tool, arguments: newAction.arguments }); leaseActionByActionId(newAction.id, { leaseOwner: 'fixture-new' }); beginActionAttempt({ queueId: newQueue.id, leaseOwner: 'fixture-new' });
  db.prepare("UPDATE agent_runs SET status='completed',model_call_count=3,metered_model_calls=2,input_tokens=250,output_tokens=60 WHERE id=?").run(runId);
  const next = createRun({ actorId: 'owner', objective: VALUE, correlationId: 'fixture_next', goalId: goal.id });
  db.prepare('UPDATE agent_runs SET model_call_count=2,metered_model_calls=1,input_tokens=75,output_tokens=10 WHERE id=?').run(next);
  db.prepare("UPDATE owners SET passphrase_hash='fixture changed hash' WHERE id='owner'").run();
  db.prepare('UPDATE entities SET name=? WHERE id=?').run(`Renamed ${VALUE}`, entity.id);
  db.prepare("UPDATE goals SET constraints=?,budgets=?,status='cancelled' WHERE id=?").run(JSON.stringify([VALUE]), JSON.stringify({ maxRuns: 4, maxModelCalls: 9, maxTokens: 9999 }), goal.id);
  fs.writeFileSync(path.join(source, 'policies/policies.yaml'), `fixture: changed ${VALUE}\n`); fs.writeFileSync(path.join(source, 'policies/data-processing.yaml'), `fixture: changed ${VALUE}\n`);
  const file = path.join(source, 'db/u2os.sqlite'), wal = `${file}-wal`; assert.ok(fs.statSync(wal).size > 0);
  const before = [fs.readFileSync(file),fs.readFileSync(wal),fs.readFileSync(path.join(target, 'db/u2os.sqlite'))];
  const result = await cleanComparison(source, target);
  assert.equal(result.ownerEntityMatched, true); assert.equal(result.ownerAuthenticationChanged, true); assert.deepEqual(result.policies, { authorizationChanged: true, dataProcessingChanged: true });
  assert.deepEqual(result.actions, { originalOnly: 1, recordedCompletionsBeyondSnapshot: 1, newOrChangedAttemptEvidence: 2, originalInFlightAttempts: 1 });
  assert.deepEqual(result.runs, { originalOnly: 1 }); assert.deepEqual(result.resources, { modelCallsBeyondSnapshot: 4, recordedInputTokensBeyondSnapshot: 225, recordedOutputTokensBeyondSnapshot: 50, originalRunsWithUnmeteredCalls: 2, monetaryCostAvailable: false, matchingRunsWithRegressedCounters: 0 });
  assert.deepEqual(result.goals, { originalOnly: 0, missingFromOriginal: 0, changedScopeOrBudget: 1, originalCancellationsBeyondSnapshot: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private-comparison|fixture|Renamed|example\.test/);
  assert.deepEqual(fs.readFileSync(file), before[0]); assert.deepEqual(fs.readFileSync(wal), before[1]); assert.deepEqual(fs.readFileSync(path.join(target, 'db/u2os.sqlite')), before[2]);
}));

test('original-only/missing goals are counted without importing their private objectives or scope', () => fixture(async ({ source, target, goal }) => {
  process.env.U2OS_HOME = source; getDb().prepare('DELETE FROM goals WHERE id=?').run(goal.id);
  createGoalDraft('owner', { objective: VALUE, completionCriteria: [VALUE], constraints: [], permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 2, maxModelCalls: 2, maxTokens: 1000 } });
  const result = await cleanComparison(source, target);
  assert.deepEqual(result.goals, { originalOnly: 1, missingFromOriginal: 1, changedScopeOrBudget: 0, originalCancellationsBeyondSnapshot: 0 }); assert.ok(!JSON.stringify(result).includes(VALUE));
}));

test('unmetered calls and regressed recorded counters remain explicit rather than invented zero spending', () => fixture(async ({ source, target }) => {
  const db = open(source); db.exec('UPDATE agent_runs SET metered_model_calls=0,input_tokens=0,output_tokens=0;'); db.close();
  const result = await cleanComparison(source, target);
  assert.equal(result.resources.originalRunsWithUnmeteredCalls, 1); assert.equal(result.resources.matchingRunsWithRegressedCounters, 1); assert.equal(result.resources.monetaryCostAvailable, false); assert.equal(result.resourceLedgerReconciled, false);
}));

test('connectivity completion is required; preview cannot authorize an unfinished preparation', () => fixture(async ({ source, target }) => {
  await assert.rejects(cleanComparison(source, target), { code: 'RECOVERY_COMPARISON_REFUSED' }); assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
}, { connectivity: false }));

test('aliases of the same home and active original ownership refuse and release every acquired guard', () => fixture(async ({ root, source, target }) => {
  const alias = path.join(root, 'alias'); fs.symlinkSync(target, alias);
  await assert.rejects(cleanComparison(alias, target), /refused/);
  const originalGuard = acquireHomeGuard(source);
  try { await assert.rejects(cleanComparison(source, target), /refused/); const other = acquireHomeGuard(target); other.release(); } finally { originalGuard.release(); }
  const targetGuard = acquireHomeGuard(target);
  try { await assert.rejects(cleanComparison(source, target), /refused/); const other = acquireHomeGuard(source); other.release(); } finally { targetGuard.release(); }
  assert.equal((await cleanComparison(source, target)).inactive, true);
}));

for (const invalid of ['different installation','missing original','linked database','executable schema','different owner entity','unsafe usage','linked policy']) {
  test(`${invalid} is preserved and comparison refuses without private error details`, () => fixture(async ({ root, source, target }) => {
    let selected = source;
    if (invalid === 'different installation') { const file = path.join(source, 'config/installation.json'), metadata = JSON.parse(fs.readFileSync(file)); metadata.installationId = randomUUID(); fs.writeFileSync(file, JSON.stringify(metadata)); }
    if (invalid === 'missing original') selected = path.join(root, 'never-created');
    if (invalid === 'linked database') fs.linkSync(path.join(source, 'db/u2os.sqlite'), path.join(root, 'linked-db'));
    if (invalid === 'executable schema') { const db = open(source); db.exec('CREATE VIEW fixture_bad AS SELECT * FROM owners;'); db.close(); }
    if (invalid === 'different owner entity') { process.env.U2OS_HOME = source; const other = createEntity({ type: 'person', name: VALUE }); getDb().prepare("UPDATE owners SET entity_id=? WHERE id='owner'").run(other.id); closeAllForTests(); }
    if (invalid === 'unsafe usage') { const db = open(source); db.exec('UPDATE agent_runs SET input_tokens=-1;'); db.close(); }
    if (invalid === 'linked policy') { const file = path.join(source, 'policies/policies.yaml'); fs.unlinkSync(file); fs.symlinkSync(path.join(source, 'config/config.json'), file); }
    const before = fs.readFileSync(path.join(target, 'db/u2os.sqlite'));
    await assert.rejects(cleanComparison(selected, target), (error) => error.code === 'RECOVERY_COMPARISON_REFUSED' && !error.message.includes(VALUE) && !error.message.includes(root));
    assert.deepEqual(fs.readFileSync(path.join(target, 'db/u2os.sqlite')), before); assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
    if (invalid === 'missing original') assert.equal(fs.existsSync(selected), false);
  }));
}

test('changed recovery checkpoint cannot stand in for connectivity quarantine', () => fixture(async ({ source, target }) => {
  const db = open(target); db.exec("UPDATE devices SET trust='trusted'; INSERT INTO devices(id,name,type,adapter,created_at,updated_at) VALUES('fixture_bad','private name','browser','websocket','now','now');"); db.close();
  await assert.rejects(cleanComparison(source, target), /refused/);
}));

test('CLI requires explicit original and emits counts/flags without arguments or identifiers', () => fixture(async ({ source, target, entity }) => {
  const options = { env: { ...process.env, U2OS_HOME: target } };
  const result = await exec(process.execPath, ['server/backup/recovery-compare-cli.js','--original',source], options);
  assert.match(result.stdout, /INACTIVE, read-only/); assert.doesNotMatch(result.stdout + result.stderr, /private-comparison|fixture hash|example\.test/); assert.ok(!result.stdout.includes(entity.id)); assert.ok(!result.stdout.includes(source));
  await assert.rejects(exec(process.execPath, ['server/backup/recovery-compare-cli.js','--apply',VALUE], options), (error) => !`${error.stdout}${error.stderr}`.includes(VALUE));
}));
