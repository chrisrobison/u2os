import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt } from '../server/agent/action-queue-store.js';
import { writeEncryptedFile, readEncryptedFile } from '../server/security/vault.js';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-coherent-backup-'));
  const home = path.join(root, 'source'); fs.mkdirSync(home);
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = home;
  try { await run({ root, home, output: path.join(root, 'snapshot.tar.gz') }); }
  finally {
    closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function assertNoStage(root) { assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.u2os-backup-stage-')), false); }

test('coherent backup captures WAL commits, row IDs, encrypted credentials and uncertain attempts without source migration', () => fixture(async ({ root, home, output }) => {
  const db = getDb(); db.exec('PRAGMA wal_autocheckpoint = 0;');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tasks (rowid, id, title, created_at, updated_at) VALUES (1001, 'fixture_wal_task', 'Committed only in WAL', ?, ?)").run(now, now);
  const action = recordAudit({ requestedBy: 'owner', tool: 'notifications.send', arguments: { title: 'Fixture', body: 'Uncertain fixture' }, status: 'approved' });
  const queue = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments });
  leaseActionByActionId(action.id, { leaseOwner: 'fixture-interrupted', leaseMs: 60000 });
  beginActionAttempt({ queueId: queue.id, leaseOwner: 'fixture-interrupted' });
  fs.writeFileSync(path.join(home, 'config', 'fixture.json'), '{"scope":"fixture-only"}', { mode: 0o600 });
  writeEncryptedFile('fixture-backup', { token: 'fixture-secret-not-a-real-token' }, home);
  const before = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(queue.id);
  const mainBytes = fs.readFileSync(path.join(home, 'db', 'u2os.sqlite'));
  assert.ok(fs.statSync(path.join(home, 'db', 'u2os.sqlite-wal')).size > 0);
  await createBackup({ dataDir: home, outputPath: output });
  assert.deepEqual(fs.readFileSync(path.join(home, 'db', 'u2os.sqlite')), mainBytes);
  assert.deepEqual(db.prepare('SELECT * FROM action_queue WHERE id = ?').get(queue.id), before);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const listing = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' });
  assert.ok(!listing.includes('.runtime-lock.sqlite'));
  assert.ok(!listing.includes('u2os.sqlite-wal'));
  assert.ok(!listing.includes('u2os.sqlite-shm'));
  const destination = path.join(root, 'isolated-restore');
  restoreBackup({ archivePath: output, dataDir: destination });
  const restored = new DatabaseSync(path.join(destination, 'db', 'u2os.sqlite'), { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare("SELECT rowid FROM tasks WHERE id = 'fixture_wal_task'").get().rowid, 1001);
    assert.deepEqual({ ...restored.prepare('SELECT * FROM action_queue WHERE id = ?').get(queue.id) }, { ...before });
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM action_attempts WHERE queue_id = ?').get(queue.id).n, 1);
    assert.equal(restored.prepare('SELECT status FROM action_queue WHERE id = ?').get(queue.id).status, 'executing');
  } finally { restored.close(); }
  assert.equal(fs.readFileSync(path.join(destination, 'config', 'fixture.json'), 'utf8'), '{"scope":"fixture-only"}');
  assert.deepEqual(readEncryptedFile('fixture-backup', destination), { token: 'fixture-secret-not-a-real-token' });
  assertNoStage(root);
}));

test('owned source rejection precedes application reads and output creation', () => fixture(async ({ root, home, output }) => {
  fs.symlinkSync('missing-owner-credential-directory', path.join(home, 'credentials'));
  const guard = acquireHomeGuard(home);
  try {
    await assert.rejects(createBackup({ dataDir: home, outputPath: output }), { code: 'HOME_IN_USE' });
    assert.equal(fs.existsSync(output), false);
    assertNoStage(root);
    assert.equal(fs.readlinkSync(path.join(home, 'credentials')), 'missing-owner-credential-directory');
  } finally { guard.release(); }
}));

test('backup owns the source across asynchronous staging and releases after publication', () => fixture(async ({ root, home, output }) => {
  getDb();
  const pending = createBackup({ dataDir: home, outputPath: output });
  assert.throws(() => acquireHomeGuard(home), { code: 'HOME_IN_USE' });
  await pending;
  const guard = acquireHomeGuard(home); guard.release();
  assert.ok(fs.existsSync(output)); assertNoStage(root);
}));

test('backup cannot overwrite an archive or write inside a source through parent aliases', () => fixture(async ({ root, home, output }) => {
  fs.writeFileSync(output, 'preserve-existing-archive');
  await assert.rejects(createBackup({ dataDir: home, outputPath: output }), /already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'preserve-existing-archive');
  const alias = path.join(root, 'source-alias'); fs.symlinkSync(home, alias, 'dir');
  for (const target of [path.join(home, 'snapshot.tar.gz'), path.join(alias, 'new-parent', 'snapshot.tar.gz')]) {
    await assert.rejects(createBackup({ dataDir: home, outputPath: target }), /outside the source/);
  }
  assert.equal(fs.existsSync(path.join(home, 'new-parent')), false);
  assertNoStage(root);
}));

test('concurrent independent homes cannot clobber the same published archive', () => fixture(async ({ root, home, output }) => {
  const second = path.join(root, 'second-source'); fs.mkdirSync(second);
  fs.writeFileSync(path.join(home, 'marker.txt'), 'first source');
  fs.writeFileSync(path.join(second, 'marker.txt'), 'second source');
  const outcomes = await Promise.allSettled([createBackup({ dataDir: home, outputPath: output }), createBackup({ dataDir: second, outputPath: output })]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find((result) => result.status === 'rejected').reason.message, /already exists/);
  const destination = path.join(root, 'isolated-winner'); restoreBackup({ archivePath: output, dataDir: destination });
  assert.equal(fs.readFileSync(path.join(destination, 'marker.txt'), 'utf8'), outcomes[0].status === 'fulfilled' ? 'first source' : 'second source');
  assertNoStage(root);
}));

test('unsupported links fail without following targets, publish nothing and release ownership', () => fixture(async ({ root, home, output }) => {
  fs.writeFileSync(path.join(root, 'private-fixture'), 'Do not follow this link');
  fs.symlinkSync(path.join(root, 'private-fixture'), path.join(home, 'private-link'));
  await assert.rejects(createBackup({ dataDir: home, outputPath: output }), /links or special files are unsupported/);
  assert.equal(fs.readFileSync(path.join(root, 'private-fixture'), 'utf8'), 'Do not follow this link');
  assert.equal(fs.existsSync(output), false); assertNoStage(root);
  const guard = acquireHomeGuard(home); guard.release();
}));

test('corrupt application SQLite does not migrate source or publish a partial snapshot', () => fixture(async ({ root, home, output }) => {
  fs.mkdirSync(path.join(home, 'db'));
  const database = path.join(home, 'db', 'u2os.sqlite'); fs.writeFileSync(database, 'fixture-corrupt-storage');
  await assert.rejects(createBackup({ dataDir: home, outputPath: output }));
  assert.equal(fs.readFileSync(database, 'utf8'), 'fixture-corrupt-storage');
  assert.equal(fs.existsSync(output), false); assertNoStage(root);
  const guard = acquireHomeGuard(home); guard.release();
}));

test('backup preserves old schemas without adding current columns', () => fixture(async ({ root, home, output }) => {
  fs.mkdirSync(path.join(home, 'db'));
  const db = new DatabaseSync(path.join(home, 'db', 'u2os.sqlite'));
  db.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT); INSERT INTO facts (rowid,id,value) VALUES (77,'fixture_old_fact','Keep this record');");
  db.close();
  await createBackup({ dataDir: home, outputPath: output });
  const destination = path.join(root, 'isolated-old-schema'); restoreBackup({ archivePath: output, dataDir: destination });
  for (const directory of [home, destination]) {
    const checked = new DatabaseSync(path.join(directory, 'db', 'u2os.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(checked.prepare('PRAGMA table_info(facts)').all().map((column) => column.name), ['id', 'value']);
      assert.equal(checked.prepare("SELECT rowid FROM facts WHERE id = 'fixture_old_fact'").get().rowid, 77);
    } finally { checked.close(); }
  }
  assertNoStage(root);
}));
