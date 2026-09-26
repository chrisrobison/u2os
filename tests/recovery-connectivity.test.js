import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createConnectionInstance, findInstance, ensureConnectionInstancesMigrated } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile, readEncryptedFile, decrypt } from '../server/security/vault.js';
import { getOrCreateDeviceConnectToken } from '../server/devices/realtime/device-token.js';
import { createModelProvider, loadModelConfig } from '../server/agent/provider-config.js';
import { createRun } from '../server/agent/run-store.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt } from '../server/agent/action-queue-store.js';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { reviewRecoveryWork } from '../server/backup/recovery-quarantine.js';
import { reviewRecoveryConnectivity } from '../server/backup/recovery-connectivity.js';
import { RECOVERY_FILE, assertExecutableHome } from '../server/backup/recovery-state.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';

const exec = promisify(execFile), VALUE = 'isolated-connectivity-fixture';
const open = (home) => new DatabaseSync(path.join(home, 'db', 'u2os.sqlite'));
const marker = (home) => JSON.parse(fs.readFileSync(path.join(home, RECOVERY_FILE), 'utf8'));
const inventoryDirectory = (home) => { const state = marker(home); return path.join(home, 'recovery-review', state.recoveryId, state.connectivityPreparation.id); };
async function fixture(operation, { work = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-connectivity-')), previous = process.env.U2OS_HOME;
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'recovery'); process.env.U2OS_HOME = source;
    fs.mkdirSync(source); ensureInstallationMode(); const db = getDb();
    const add = (connectorId, credentials) => createConnectionInstance(db, { connectorId, label: 'Private fixture account', status: 'connected', credentials });
    const google = add('google', null), row = findInstance(db, 'google', google.id);
    for (const service of ['gmail','calendar']) storeTokens(row.vault_key, service, { access_token: VALUE, refresh_token: VALUE, expires_in: 3600 }, source);
    const smtp = add('smtp', { host: 'smtp.example.test', username: VALUE, password: VALUE, from: 'fixture@example.test' });
    const imap = add('imap', { host: 'imap.example.test', username: VALUE, password: VALUE });
    db.prepare('UPDATE connection_instances SET smtp_instance_id = ?, smtp_pair_initialized = 1 WHERE id = ?').run(smtp.id, imap.id);
    add('webhook', { webhookUrl: `https://notify.example.test/${VALUE}`, format: 'json' }); add('brave-search', { apiKey: VALUE });
    writeEncryptedFile('model-anthropic', { apiKey: VALUE }, source);
    writeEncryptedFile('imap', { host: 'legacy.example.test', username: VALUE, password: VALUE }, source);
    writeEncryptedFile('google', { clientId: VALUE, clientSecret: VALUE, tokens: { gmail: { refresh_token: VALUE } } }, source);
    const token = getOrCreateDeviceConnectToken(source);
    fs.writeFileSync(path.join(source, 'config', 'config.json'), `{ "model": { "provider": "anthropic", "model": "fixture-model", "baseUrl": "https://model.example.test/${VALUE}" }, "unknownInteger":9007199254740993 }\n`);
    fs.writeFileSync(path.join(source, 'config', 'connectors.yaml'), `email:\n  active: gmail\n  activeInstanceId: ${google.id}\n`);
    const now = new Date().toISOString(), entity = createEntity({ type: 'person', name: 'Renamed fixture owner' });
    db.prepare("INSERT INTO owners(id,entity_id,passphrase_hash,salt,scrypt_params,created_at) VALUES('owner',?,'fixture hash','fixture salt','{}',?)").run(entity.id, now);
    db.prepare("INSERT INTO devices(id,name,type,status,trust,adapter,created_at,updated_at) VALUES('fixture.browser','Private fixture device','browser','online','trusted','websocket',?,?)").run(now, now);
    const runId = createRun({ actorId: 'owner', objective: 'Private fixture objective', correlationId: 'fixture_connectivity' });
    db.prepare('UPDATE agent_runs SET model_call_count=2,input_tokens=345,output_tokens=678 WHERE id=?').run(runId);
    const action = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { body: VALUE }, status: 'approved', requiresApproval: false });
    const queue = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments });
    leaseActionByActionId(action.id, { leaseOwner: 'fixture original' }); beginActionAttempt({ queueId: queue.id, leaseOwner: 'fixture original' });
    const archive = path.join(root, 'fixture.tar.gz'); await createBackup({ dataDir: source, outputPath: archive }); await restoreBackup({ archivePath: archive, dataDir: target }); closeAllForTests();
    if (work) reviewRecoveryWork({ dataDir: target, apply: true });
    const originalFiles = new Map();
    for (const name of fs.readdirSync(path.join(source, 'credentials'))) originalFiles.set(`credentials/${name}`, fs.readFileSync(path.join(source, 'credentials', name)));
    for (const name of ['config/config.json','config/connectors.yaml']) originalFiles.set(name, fs.readFileSync(path.join(source, name)));
    await operation({ root, source, target, archive, originalFiles, token, google, runId });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
}
function assertInactive(home) { assert.throws(() => assertExecutableHome(home), { code: 'RECOVERY_INACTIVE' }); assert.equal(marker(home).status, 'inactive'); }

test('counts-only preview preserves every application/config/credential/marker byte', () => fixture(async ({ target, originalFiles }) => {
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), state = fs.readFileSync(path.join(target, RECOVERY_FILE));
  assert.deepEqual(fs.readdirSync(path.join(target, 'credentials')).sort(), [...originalFiles.keys()].filter((name) => name.startsWith('credentials/')).map((name) => path.basename(name)).sort());
  const preview = reviewRecoveryConnectivity({ dataDir: target });
  assert.deepEqual(preview.counts, { accounts: 5, devices: 1, credentialFiles: 9, runtimeConfigurationFiles: 2 });
  assert.doesNotMatch(JSON.stringify(preview), /Private|fixture|example|token|hash|model|endpoint|recipient/);
  for (const [name, bytes] of originalFiles) assert.deepEqual(fs.readFileSync(path.join(target, name)), bytes);
  assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before); assert.deepEqual(fs.readFileSync(path.join(target, RECOVERY_FILE)), state);
  assert.equal(fs.existsSync(path.join(target, 'recovery-review')), false); assertInactive(target);
}));

test('apply preserves archived bytes privately, disables runtime reuse, and checkpoints once without losing personal evidence', () => fixture(async ({ source, target, archive, originalFiles, token, google, runId }) => {
  const before = open(target), attempts = before.prepare('SELECT * FROM action_attempts').all(), owners = before.prepare('SELECT * FROM owners').all(), entities = before.prepare('SELECT * FROM entities').all(), revisions = before.prepare('SELECT id,credential_revision FROM connection_instances ORDER BY id').all(); before.close();
  const archiveBytes = fs.readFileSync(archive), sourceBytes = fs.readFileSync(path.join(source, 'db', 'u2os.sqlite'));
  const applied = reviewRecoveryConnectivity({ dataDir: target, apply: true }), dir = inventoryDirectory(target);
  assert.equal(applied.alreadyApplied, false); assertInactive(target);
  for (const [name, bytes] of originalFiles) {
    const file = path.join(name === 'credentials/master.key' ? target : dir, name);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    if (name !== 'credentials/master.key') assert.equal(fs.existsSync(path.join(target, name)), false);
    assert.deepEqual(fs.readFileSync(path.join(source, name)), bytes);
  }
  for (const directory of [path.join(target, 'recovery-review'), path.dirname(dir), dir, path.join(dir, 'credentials'), path.join(dir, 'config')]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(readEncryptedFile(`google__${google.id}`, target), null); assert.equal(readEncryptedFile('imap', target), null); assert.equal(readEncryptedFile('model-anthropic', target), null);
  assert.equal(decrypt(JSON.parse(fs.readFileSync(path.join(dir, `credentials/google__${google.id}.enc.json`))), target).tokens.gmail.refresh_token, VALUE);
  assert.deepEqual(loadModelConfig(target), { provider: 'mock' }); assert.throws(() => createModelProvider(target), { code: 'MODEL_UNAVAILABLE' });
  const db = open(target);
  try {
    assert.deepEqual(db.prepare('SELECT * FROM owners').all(), owners); assert.deepEqual(db.prepare('SELECT * FROM entities').all(), entities); assert.deepEqual(db.prepare('SELECT * FROM action_attempts').all(), attempts);
    const usage = db.prepare('SELECT model_call_count,input_tokens,output_tokens FROM agent_runs WHERE id=?').get(runId); assert.deepEqual({ ...usage }, { model_call_count: 2, input_tokens: 345, output_tokens: 678 });
    for (const previous of revisions) { const account = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(previous.id); assert.equal(account.status, 'disconnected'); assert.equal(account.credential_revision, previous.credential_revision + 1); assert.equal(account.smtp_instance_id, null); }
    assert.deepEqual({ ...db.prepare('SELECT status,trust FROM devices').get() }, { status: 'offline', trust: 'revoked' });
  } finally { db.close(); }
  const receiptBytes = fs.readFileSync(path.join(target, RECOVERY_FILE)), dbBytes = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  assert.equal(reviewRecoveryConnectivity({ dataDir: target, apply: true }).alreadyApplied, true); assert.equal(reviewRecoveryConnectivity({ dataDir: target }).alreadyApplied, true);
  assert.deepEqual(fs.readFileSync(path.join(target, RECOVERY_FILE)), receiptBytes); assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), dbBytes);
  const legacy = open(target); try { const result = ensureConnectionInstancesMigrated({ db: legacy, dataDir: target }); assert.ok(result.every((entry) => !entry.migrated)); assert.equal(legacy.prepare('SELECT count(*) n FROM connection_instances').get().n, 5); } finally { legacy.close(); }
  assert.notEqual(getOrCreateDeviceConnectToken(target), token);
  assert.deepEqual(fs.readFileSync(archive), archiveBytes); assert.deepEqual(fs.readFileSync(path.join(source, 'db', 'u2os.sqlite')), sourceBytes);
}));

test('unfinished work cannot enter connectivity review', () => fixture(async ({ target }) => {
  const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')); assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), { code: 'RECOVERY_CONNECTIVITY_REFUSED' });
  assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before); assert.equal(marker(target).connectivityPreparation, undefined);
}, { work: false }));

test('normal homes and owned aliases are refused without configuration changes', () => fixture(async ({ root, source, target, originalFiles }) => {
  assert.throws(() => reviewRecoveryConnectivity({ dataDir: source, apply: true }), /refused/);
  const alias = path.join(root, 'alias'); fs.symlinkSync(target, alias); const guard = acquireHomeGuard(target);
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: alias, apply: true }), { code: 'HOME_IN_USE' }); } finally { guard.release(); }
  for (const [name, bytes] of originalFiles) assert.deepEqual(fs.readFileSync(path.join(target, name)), bytes);
}));

for (const bad of ['linked credential','linked review area','unknown credential','oversized credential','executable schema','missing master']) {
  test(`unsupported ${bad} is refused before any connectivity preparation`, () => fixture(async ({ target }) => {
    const file = path.join(target, 'credentials', 'imap.enc.json');
    if (bad === 'linked credential') fs.linkSync(file, path.join(target, 'linked-fixture'));
    if (bad === 'linked review area') fs.symlinkSync(path.join(target, 'credentials'), path.join(target, 'recovery-review'));
    if (bad === 'unknown credential') fs.writeFileSync(path.join(target, 'credentials', 'unsupported.txt'), VALUE);
    if (bad === 'oversized credential') fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    if (bad === 'executable schema') { const db = open(target); db.exec('CREATE INDEX fixture_bad ON devices(length(id));'); db.close(); }
    if (bad === 'missing master') fs.unlinkSync(path.join(target, 'credentials', 'master.key'));
    const before = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
    assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); assert.equal(marker(target).connectivityPreparation, undefined);
    assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), before); assertInactive(target);
  }));
}

test('interrupted copy publication leaves active bytes intact and explicit retry completes the same inventory', () => fixture(async ({ target }) => {
  const rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => { if (!interrupted && String(from).includes('.copy-stage-')) { interrupted = true; throw new Error(VALUE); } return rename(from, to); };
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), (error) => !error.message.includes(VALUE)); } finally { fs.renameSync = rename; }
  assert.equal(interrupted, true); const id = marker(target).connectivityPreparation.id;
  assert.equal(reviewRecoveryConnectivity({ dataDir: target }).inProgress, true); assertInactive(target);
  reviewRecoveryConnectivity({ dataDir: target, apply: true }); assert.equal(marker(target).connectivityPreparation.id, id);
}));

for (const location of ['active','held']) test(`changed ${location} bytes are preserved and refused on retry`, () => fixture(async ({ target }) => {
  const unlink = fs.unlinkSync; let held;
  fs.unlinkSync = (file) => { if (String(file).endsWith('config/config.json')) { held = path.join(inventoryDirectory(target), 'config/config.json'); throw new Error(VALUE); } return unlink(file); };
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); } finally { fs.unlinkSync = unlink; }
  assert.ok(held); const changed = location === 'held' ? held : path.join(target, 'config/config.json');
  fs.writeFileSync(changed, 'Changed private fixture'); const bytes = fs.readFileSync(changed);
  assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); assert.deepEqual(fs.readFileSync(changed), bytes); assertInactive(target);
}));

test('legacy AppleDouble sidecars are preserved offline rather than interpreted or discarded', () => fixture(async ({ target }) => {
  const metadata = ['credentials/._master.key','credentials/._device-connect-token.key','config/._config.json','config/._connectors.yaml'];
  for (const name of metadata) fs.writeFileSync(path.join(target, name), Buffer.from([0,5,22,7,255]));
  const preview = reviewRecoveryConnectivity({ dataDir: target }); assert.equal(preview.counts.credentialFiles, 11); assert.equal(preview.counts.runtimeConfigurationFiles, 4);
  reviewRecoveryConnectivity({ dataDir: target, apply: true });
  for (const name of metadata) { assert.deepEqual(fs.readFileSync(path.join(inventoryDirectory(target), name)), Buffer.from([0,5,22,7,255])); assert.equal(fs.existsSync(path.join(target, name)), false); }
  assertInactive(target);
}));

test('database rollback after file quarantine can resume without another revision or audit', () => fixture(async ({ target }) => {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith('INSERT INTO events')) throw new Error(VALUE); return prepare.call(this, sql); };
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); } finally { DatabaseSync.prototype.prepare = prepare; }
  const db = open(target); assert.equal(db.prepare("SELECT count(*) n FROM connection_instances WHERE status='connected'").get().n, 5); db.close(); assertInactive(target);
  assert.equal(reviewRecoveryConnectivity({ dataDir: target }).inProgress, true); reviewRecoveryConnectivity({ dataDir: target, apply: true });
  const final = open(target); try { assert.equal(final.prepare("SELECT count(*) n FROM events WHERE type='system.recovery_connectivity_quarantined'").get().n, 1); assert.equal(final.prepare('SELECT max(credential_revision) n FROM connection_instances').get().n, 1); } finally { final.close(); }
}));

test('committed database checkpoint survives marker publication failure and repairs once', () => fixture(async ({ target }) => {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith(RECOVERY_FILE) && marker(target).connectivityPreparation) throw new Error(VALUE); return rename(from, to); };
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); } finally { fs.renameSync = rename; }
  assert.equal(marker(target).connectivityQuarantine, undefined); assertInactive(target);
  assert.equal(reviewRecoveryConnectivity({ dataDir: target, apply: true }).alreadyApplied, true); assert.ok(marker(target).connectivityQuarantine);
}));

test('SIGKILL during database transaction retains moved files and rolls back before explicit retry', () => fixture(async ({ target }) => {
  await assert.rejects(exec(process.execPath, ['tests/helpers/connectivity-interrupted-child.js'], { env: { ...process.env, U2OS_HOME: target } }), (error) => error.signal === 'SIGKILL');
  assertInactive(target); reviewRecoveryConnectivity({ dataDir: target, apply: true });
  const db = open(target); try { assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.recovery_connectivity_quarantined'").get().n, 1); assert.equal(db.prepare('SELECT max(credential_revision) n FROM connection_instances').get().n, 1); } finally { db.close(); }
}));

test('SIGKILL after a durable copy but before unlink resumes without dropping either evidence copy', () => fixture(async ({ target }) => {
  await assert.rejects(exec(process.execPath, ['tests/helpers/connectivity-interrupted-child.js','files'], { env: { ...process.env, U2OS_HOME: target } }), (error) => error.signal === 'SIGKILL');
  assertInactive(target); assert.equal(reviewRecoveryConnectivity({ dataDir: target }).inProgress, true);
  reviewRecoveryConnectivity({ dataDir: target, apply: true }); assert.equal(reviewRecoveryConnectivity({ dataDir: target }).alreadyApplied, true);
}));

test('private inventory tampering is refused without disclosing its extra content or enabling connectivity', () => fixture(async ({ target }) => {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(from).includes('.copy-stage-')) throw new Error(VALUE); return rename(from, to); };
  try { assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), /refused/); } finally { fs.renameSync = rename; }
  const file = path.join(inventoryDirectory(target), 'inventory.json'), inventory = JSON.parse(fs.readFileSync(file));
  inventory.privatePayload = VALUE; fs.writeFileSync(file, JSON.stringify(inventory));
  assert.throws(() => reviewRecoveryConnectivity({ dataDir: target, apply: true }), (error) => !error.message.includes(VALUE)); assertInactive(target);
}));

test('CLI previews and applies without private values or providers; unknown flags do not echo inputs', () => fixture(async ({ target }) => {
  const options = { env: { ...process.env, U2OS_HOME: target } };
  const preview = await exec(process.execPath, ['server/backup/recovery-connectivity-cli.js'], options); assert.match(preview.stdout, /INACTIVE/); assert.doesNotMatch(preview.stdout + preview.stderr, /isolated-connectivity|example\.test|Private fixture/);
  const apply = await exec(process.execPath, ['server/backup/recovery-connectivity-cli.js','--apply'], options); assert.match(apply.stdout, /No provider or model/); assertInactive(target);
  await assert.rejects(exec(process.execPath, ['server/backup/recovery-connectivity-cli.js',VALUE], options), (error) => !`${error.stdout}${error.stderr}`.includes(VALUE));
}));
