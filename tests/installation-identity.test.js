import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureInstallationMode, readInstallationMode, readInstallationIdentity, installationModePath } from '../server/seed/installation-mode.js';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { RECOVERY_FILE } from '../server/backup/recovery-state.js';
import { withOfflineHome } from '../server/runtime/offline-home.js';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-identity-'));
  const previous = process.env.U2OS_HOME;
  try { await run(root); }
  finally {
    closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const initialize = (home, mode = null) => withOfflineHome(() => ensureInstallationMode(mode, home), { dataDir: home });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('fresh personal/demo identities are distinct, stable across reads, rename and initialization', () => fixture(async (root) => {
  const personal = path.join(root, 'personal'), demo = path.join(root, 'demo');
  await initialize(personal); await initialize(demo, 'demo');
  const id = readInstallationIdentity(personal), demoId = readInstallationIdentity(demo);
  assert.match(id, uuid); assert.match(demoId, uuid); assert.notEqual(id, demoId);
  const before = fs.readFileSync(installationModePath(personal)); const stat = fs.statSync(installationModePath(personal));
  assert.equal(readInstallationMode(personal), 'personal'); assert.equal(readInstallationMode(demo), 'demo');
  await initialize(personal); await initialize(demo);
  assert.deepEqual(fs.readFileSync(installationModePath(personal)), before); assert.equal(fs.statSync(installationModePath(personal)).ino, stat.ino);
  const renamed = path.join(root, 'renamed'); fs.renameSync(personal, renamed); await initialize(renamed);
  assert.equal(readInstallationIdentity(renamed), id); assert.equal(fs.statSync(installationModePath(renamed)).mode & 0o777, 0o600);
}));

test('additive legacy migration preserves configuration fields and real SQLite records without rewriting again', () => fixture(async (root) => {
  const home = path.join(root, 'legacy'); fs.mkdirSync(path.join(home, 'config'), { recursive: true }); fs.mkdirSync(path.join(home, 'db'));
  const saved = { mode: 'personal', createdAt: '2020-01-01T00:00:00Z', ownerName: 'Changed name', custom: { keep: ['fixture real preference'] } };
  fs.writeFileSync(installationModePath(home), JSON.stringify(saved));
  const database = path.join(home, 'db', 'u2os.sqlite'); const db = new DatabaseSync(database);
  db.exec("CREATE TABLE real_record (name TEXT); INSERT INTO real_record VALUES('fixture retained contact');"); db.close();
  const records = fs.readFileSync(database);
  assert.equal(readInstallationIdentity(home), null); await initialize(home);
  const updated = JSON.parse(fs.readFileSync(installationModePath(home))); assert.match(updated.installationId, uuid);
  const { installationId, ...unrelated } = updated; assert.deepEqual(unrelated, saved);
  const before = fs.readFileSync(installationModePath(home)); await initialize(home);
  assert.deepEqual(fs.readFileSync(installationModePath(home)), before); assert.deepEqual(fs.readFileSync(database), records);
  assert.equal(fs.readdirSync(path.join(home, 'config')).some((name) => name.startsWith('.installation-stage-')), false);
}));

test('migration preserves raw unknown JSON fields beyond JS numeric precision and owner formatting', () => fixture(async (root) => {
  const home = path.join(root, 'raw'); fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const original = '{\n  "mode": "personal", "largeInteger": 9007199254740993, "escaped": "\\u00e9"\n}\n';
  fs.writeFileSync(installationModePath(home), original); await initialize(home);
  const updated = fs.readFileSync(installationModePath(home), 'utf8');
  assert.ok(updated.startsWith(original.slice(0, original.lastIndexOf('}'))));
  assert.match(updated, /9007199254740993/); assert.ok(updated.includes('"escaped": "\\u00e9"')); assert.match(readInstallationIdentity(home), uuid);
}));

for (const value of [null, [], { mode: 'other' }, { mode: 'personal', installationId: null }, { mode: 'personal', installationId: 'fixture confidential invalid identity' }, { mode: 'personal', installationId: 42 }]) {
  test(`invalid installation metadata is preserved (${JSON.stringify(value)})`, () => fixture(async (root) => {
    const home = path.join(root, 'invalid'); fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    const file = installationModePath(home); fs.writeFileSync(file, JSON.stringify(value)); const original = fs.readFileSync(file);
    await assert.rejects(initialize(home), (error) => error.code === 'INSTALLATION_METADATA_INVALID' && !error.message.includes('confidential'));
    assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readdirSync(path.join(home, 'config')), ['installation.json']);
  }));
}

test('malformed UTF8/JSON and oversized metadata fail without replacement', () => fixture(async (root) => {
  for (const [index, bytes] of [Buffer.from('{broken fixture secret'), Buffer.concat([Buffer.from('{"mode":"personal","custom":"'), Buffer.from([255]), Buffer.from('"}')]), Buffer.alloc(1024 * 1024 + 1)].entries()) {
    const home = path.join(root, `invalid-${index}`); fs.mkdirSync(path.join(home, 'config'), { recursive: true }); const file = installationModePath(home); fs.writeFileSync(file, bytes);
    await assert.rejects(initialize(home), { code: 'INSTALLATION_METADATA_INVALID' }); assert.deepEqual(fs.readFileSync(file), bytes);
  }
}));

test('metadata symlinks, directory aliases and hard links are never followed or replaced', () => fixture(async (root) => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); const file = path.join(outside, 'installation.json'); const content = '{"mode":"personal","private":"fixture outside data"}'; fs.writeFileSync(file, content);
  for (const kind of ['file', 'directory', 'hardlink']) {
    const home = path.join(root, kind); fs.mkdirSync(home);
    if (kind === 'directory') fs.symlinkSync(outside, path.join(home, 'config'));
    else { fs.mkdirSync(path.join(home, 'config')); if (kind === 'file') fs.symlinkSync(file, installationModePath(home)); else fs.linkSync(file, installationModePath(home)); }
    await assert.rejects(initialize(home), { code: 'INSTALLATION_METADATA_INVALID' }); assert.equal(fs.readFileSync(file, 'utf8'), content);
    if (kind === 'file') assert.ok(fs.lstatSync(installationModePath(home)).isSymbolicLink());
  }
}));

test('interrupted additive metadata write preserves the old config and a later initialization upgrades once', (t) => fixture(async (root) => {
  const home = path.join(root, 'legacy'); fs.mkdirSync(path.join(home, 'config'), { recursive: true }); const file = installationModePath(home);
  fs.writeFileSync(file, '{"mode":"personal","retain":"fixture preference"}'); const original = fs.readFileSync(file);
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('fixture private filesystem failure'); });
  await assert.rejects(initialize(home), { code: 'INSTALLATION_METADATA_INVALID' }); assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(path.join(home, 'config')), ['installation.json']); failure.mock.restore();
  await initialize(home); const id = readInstallationIdentity(home); assert.match(id, uuid); await initialize(home); assert.equal(readInstallationIdentity(home), id);
}));

test('late persistence failure never regenerates an already-published identity on retry', (t) => fixture(async (root) => {
  const home = path.join(root, 'late-failure'); const fsync = fs.fsyncSync;
  const failure = t.mock.method(fs, 'fsyncSync', (fd) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture private directory failure'); return fsync(fd); });
  await assert.rejects(initialize(home), { code: 'INSTALLATION_METADATA_INVALID' });
  const id = readInstallationIdentity(home); assert.match(id, uuid); failure.mock.restore();
  await initialize(home); assert.equal(readInstallationIdentity(home), id);
}));

test('runtime restart and owner display-name changes cannot change installation identity', () => fixture(async (root) => {
  process.env.U2OS_HOME = path.join(root, 'runtime'); let handle;
  try {
    handle = await startServer({ port: 0 }); const id = readInstallationIdentity(); assert.match(id, uuid);
    await handle.auth.setup('fixture-only owner passphrase'); const owner = handle.auth.ownerEntity().id;
    handle.auth.db.prepare('UPDATE entities SET name = ? WHERE id = ?').run('Renamed fixture owner', owner);
    await handle.shutdown(); closeAllForTests(); handle = await startServer({ port: 0 });
    assert.equal(readInstallationIdentity(), id); assert.equal(handle.auth.ownerEntity().id, owner);
  } finally { await handle?.shutdown(); }
}));

test('invalid identity blocks runtime before credentials/database creation and preserves metadata', () => fixture(async (root) => {
  const home = path.join(root, 'invalid-runtime'); process.env.U2OS_HOME = home; fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(installationModePath(home), '{"mode":"personal","installationId":"fixture invalid identity"}'); const original = fs.readFileSync(installationModePath(home));
  await assert.rejects(startServer({ port: 0 }), { code: 'INSTALLATION_METADATA_INVALID' });
  assert.deepEqual(fs.readFileSync(installationModePath(home)), original); assert.equal(fs.existsSync(path.join(home, 'credentials')), false); assert.equal(fs.existsSync(path.join(home, 'db')), false);
}));

test('backup preserves known identity and legacy absence without initializing its source; restore remains inactive', () => fixture(async (root) => {
  for (const known of [true, false]) {
    const source = path.join(root, `source-${known}`); fs.mkdirSync(source);
    if (known) await initialize(source); else { fs.mkdirSync(path.join(source, 'config')); fs.writeFileSync(installationModePath(source), '{"mode":"personal","retain":"legacy"}'); }
    const original = fs.readFileSync(installationModePath(source)); const id = readInstallationIdentity(source);
    const archive = path.join(root, `fixture-${known}.tar.gz`); await createBackup({ dataDir: source, outputPath: archive });
    assert.deepEqual(fs.readFileSync(installationModePath(source)), original);
    const target = path.join(root, `recovery-${known}`); await restoreBackup({ archivePath: archive, dataDir: target });
    const marker = JSON.parse(fs.readFileSync(path.join(target, RECOVERY_FILE))); assert.equal(marker.installationId, id); assert.equal(marker.status, 'inactive');
    assert.deepEqual(fs.readFileSync(installationModePath(target)), original); await assert.rejects(initialize(target), { code: 'RECOVERY_INACTIVE' });
  }
}));
