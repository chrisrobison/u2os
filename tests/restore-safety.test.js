import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { readArchive } from '../server/backup/archive-reader.js';
import { restoreBackup, createBackup } from '../server/backup/snapshot.js';
import { RECOVERY_FILE, assertExecutableHome } from '../server/backup/recovery-state.js';
import { acquireHomeGuard } from '../server/runtime/home-guard.js';
import { withOfflineHome } from '../server/runtime/offline-home.js';
import { startServer } from '../server/index.js';

const exec = promisify(execFile);
async function fixture(t, operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-restore-test-'));
  const mktemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (prefix, ...args) => mktemp(String(prefix).includes('u2os-restore-stage-') ? path.join(root, 'private-stage-') : prefix, ...args));
  try { await operation({ root, target: path.join(root, 'recovery'), archive: path.join(root, 'fixture.tar.gz') }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function entry(name, { type = '0', data = Buffer.from('fixture'), size = data.length, link = '', prefix = '' } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
  header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345, 155);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function archive(file, entries, ending = Buffer.alloc(1024)) { fs.writeFileSync(file, gzipSync(Buffer.concat([...entries, ending]))); }
function record(key, value) {
  const text = `${key}=${value}\n`; let length = Buffer.byteLength(text) + 2;
  while (length !== Buffer.byteLength(text) + String(length).length + 1) length = Buffer.byteLength(text) + String(length).length + 1;
  return Buffer.from(`${length} ${text}`);
}

for (const name of ['../escaped', '/absolute', 'folder/../escaped', 'C:/escaped', 'folder\\escaped', 'folder//ambiguous', 'folder/./ambiguous', 'private\ncontent']) {
  test(`restore rejects unsafe path ${JSON.stringify(name)} before destination creation`, (t) => fixture(t, async ({ root, target, archive: input }) => {
    archive(input, [entry(name)]);
    await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /archive path is unsafe/);
    assert.equal(fs.existsSync(target), false); assert.deepEqual(fs.readdirSync(root), ['fixture.tar.gz']);
  }));
}
for (const type of ['1', '2', '3', '4', '6', 'S', 'K']) {
  test(`restore rejects link/special entry type ${type}`, (t) => fixture(t, async ({ target, archive: input }) => {
    archive(input, [entry('payload', { type, link: '../../outside' })]);
    await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /special file types/); assert.equal(fs.existsSync(target), false);
  }));
}
for (const name of ['.runtime-lock.sqlite', '.runtime-lock.sqlite-journal', '.runtime-lock.sqlite/payload', '.u2os-recovery.json', '.u2os-recovery.pending', 'db/u2os.sqlite-wal']) {
  test(`archive metadata cannot supply authority: ${name}`, (t) => fixture(t, async ({ target, archive: input }) => {
    archive(input, [entry(name)]); await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /reserved runtime or recovery/); assert.equal(fs.existsSync(target), false);
  }));
}
test('duplicate files, path/type collisions and compression/checksum/truncation fail without existing target changes', (t) => fixture(t, async ({ target, archive: input }) => {
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'owner-record'), 'retain');
  const badChecksum = entry('fixture'); badChecksum[0] ^= 1;
  const binaryNumber = entry('binary'); binaryNumber[124] = 128; binaryNumber.fill(32, 148, 156);
  binaryNumber.write(`${binaryNumber.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  const cases = [[entry('same'), entry('same')], [entry('folder'), entry('folder/file')], [entry('folder/', { type: '5', data: Buffer.alloc(0) }), entry('folder')], [badChecksum], [binaryNumber], [entry('short', { size: 4096 })]];
  for (const entries of cases) {
    archive(input, entries); await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /archive/);
    assert.deepEqual(fs.readdirSync(target), ['owner-record']);
  }
  archive(input, [entry('fixture')], Buffer.alloc(512)); await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /end markers/);
  archive(input, [entry('fixture')]); const corrupt = fs.readFileSync(input); corrupt[corrupt.length - 8] ^= 1; fs.writeFileSync(input, corrupt);
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /archive/);
  archive(input, [entry('fixture')], Buffer.concat([Buffer.alloc(1024), entry('after-end')])); await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /after its end markers/);
  assert.equal(fs.readFileSync(path.join(target, 'owner-record'), 'utf8'), 'retain');
}));

test('bounded PAX and GNU long names are interpreted only as validated next-entry names', (t) => fixture(t, async ({ root, target, archive: input }) => {
  const long = `${'nested/'.repeat(20)}résumé.txt`;
  archive(input, [entry('metadata', { type: 'x', data: record('path', long) }), entry('short')]);
  await restoreBackup({ archivePath: input, dataDir: target }); assert.equal(fs.readFileSync(path.join(target, long), 'utf8'), 'fixture');
  const gnu = path.join(root, 'gnu'); archive(input, [entry('long-name', { type: 'L', data: Buffer.from(`${long}\0`) }), entry('short')]);
  await restoreBackup({ archivePath: input, dataDir: gnu }); assert.equal(fs.readFileSync(path.join(gnu, long), 'utf8'), 'fixture');
  for (const metadata of [record('path', '../outside'), record('GNU.sparse.map', '0,5'), Buffer.from('wrong-length path=example\n')]) {
    archive(input, [entry('metadata', { type: 'x', data: metadata }), entry('short')]);
    await assert.rejects(restoreBackup({ archivePath: input, dataDir: path.join(root, 'rejected') }), /archive/);
  }
}));

test('binary macOS PAX attributes are discarded, never decoded or applied', (t) => fixture(t, async ({ target, archive: input }) => {
  const raw = Buffer.concat([Buffer.from('SCHILY.xattr.com.apple.provenance='), Buffer.from([0, 255, 128, 10])]);
  let length = raw.length + 3;
  while (length !== raw.length + String(length).length + 1) length = raw.length + String(length).length + 1;
  archive(input, [entry('metadata', { type: 'x', data: Buffer.concat([Buffer.from(`${length} `), raw]) }), entry('payload')]);
  await restoreBackup({ archivePath: input, dataDir: target });
  assert.equal(fs.readFileSync(path.join(target, 'payload'), 'utf8'), 'fixture');
  assert.deepEqual(fs.readdirSync(target).sort(), ['.runtime-lock.sqlite', RECOVERY_FILE, 'payload'].sort());
}));

test('entry/bytes/metadata/path/depth limits cannot be enlarged by callers', (t) => fixture(t, async ({ root, archive: input }) => {
  const cases = [
    { entries: [entry('a'), entry('b')], limits: { maxEntries: 1 } },
    { entries: [entry('a')], limits: { maxBytes: 3 } },
    { entries: [entry('meta', { type: 'x', data: record('path', 'long-path') }), entry('a')], limits: { maxMetadataBytes: 3 } },
    { entries: [entry('long')], limits: { maxPathBytes: 2 } },
    { entries: [entry('a/b/c')], limits: { maxDepth: 2 } },
  ];
  for (const [index, item] of cases.entries()) {
    archive(input, item.entries); await assert.rejects(readArchive(input, path.join(root, `stage-${index}`), item.limits), /limit|exceeds|unsafe/);
  }
  await assert.rejects(readArchive(input, path.join(root, 'invalid-limits'), { maxBytes: Number.MAX_SAFE_INTEGER }), /limits are invalid/);
  assert.equal(fs.existsSync(path.join(root, 'invalid-limits')), false);
}));

test('SQLite corruption and nonempty/forced/active alias targets preserve records and archives', (t) => fixture(t, async ({ root, target, archive: input }) => {
  archive(input, [entry('db/u2os.sqlite', { data: Buffer.from('not a database') })]);
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /SQLite integrity/); assert.equal(fs.existsSync(target), false);
  archive(input, [entry('fixture')]); const original = fs.readFileSync(input);
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target, force: true }), /force restore/); assert.equal(fs.existsSync(target), false);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'owner-record'), 'retain');
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /non-empty/);
  const active = path.join(root, 'active'); const guard = acquireHomeGuard(active); const alias = path.join(root, 'alias'); fs.symlinkSync(active, alias);
  try { await assert.rejects(restoreBackup({ archivePath: input, dataDir: alias }), /non-empty|already in use/); assert.deepEqual(fs.readdirSync(active), ['.runtime-lock.sqlite']); }
  finally { guard.release(); }
  assert.deepEqual(fs.readFileSync(input), original); assert.deepEqual(fs.readdirSync(target), ['owner-record']);
}));

test('verified recovery preserves old schema and stays inactive before startup or offline migrations', (t) => fixture(t, async ({ root, target, archive: input }) => {
  const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'db'), { recursive: true });
  const file = path.join(source, 'db', 'u2os.sqlite'); const db = new DatabaseSync(file);
  db.exec("CREATE TABLE legacy (content TEXT); INSERT INTO legacy(rowid,content) VALUES(77,'retain real fixture record');"); db.close();
  const original = fs.readFileSync(file); await createBackup({ dataDir: source, outputPath: input }); await restoreBackup({ archivePath: input, dataDir: target });
  const marker = JSON.parse(fs.readFileSync(path.join(target, RECOVERY_FILE))); assert.equal(marker.status, 'inactive'); assert.equal(marker.database, 'ok');
  const restoredBeforeStartup = fs.readFileSync(path.join(target, 'db', 'u2os.sqlite'));
  const restored = new DatabaseSync(path.join(target, 'db', 'u2os.sqlite'), { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT rowid FROM legacy').get().rowid, 77);
    assert.equal(restored.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n, 1);
  } finally { restored.close(); }
  assert.equal(fs.statSync(target).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(target, 'db', 'u2os.sqlite')).mode & 0o777, 0o600);
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = target;
  try {
    await assert.rejects(startServer({ port: 0, mode: 'demo', developmentMode: true }), { code: 'RECOVERY_INACTIVE' });
    let called = false; await assert.rejects(withOfflineHome(() => { called = true; }), { code: 'RECOVERY_INACTIVE' }); assert.equal(called, false);
  } finally { if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; }
  assert.deepEqual(fs.readFileSync(path.join(target, 'db', 'u2os.sqlite')), restoredBeforeStartup);
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(fs.existsSync(path.join(target, 'config')), false); assert.equal(fs.existsSync(path.join(target, 'credentials')), false);
  for (const status of ['incomplete', 'active', '{malformed']) {
    fs.writeFileSync(path.join(target, RECOVERY_FILE), status === '{malformed' ? status : JSON.stringify({ version: 1, status }));
    assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
  }
}));

test('publication failure retains a durable incomplete marker and never auto-resumes', (t) => fixture(t, async ({ target, archive: input }) => {
  archive(input, [entry('first'), entry('second')]); const copy = fs.copyFileSync; let count = 0;
  t.mock.method(fs, 'copyFileSync', (...args) => { if (++count === 2) throw new Error('fixture private secret must not leak'); return copy(...args); });
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /publication incomplete/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, RECOVERY_FILE))).status, 'incomplete');
  assert.equal(fs.readFileSync(path.join(target, 'first'), 'utf8'), 'fixture'); assert.equal(fs.existsSync(path.join(target, 'second')), false);
  assert.throws(() => assertExecutableHome(target), { code: 'RECOVERY_INACTIVE' });
  await assert.rejects(restoreBackup({ archivePath: input, dataDir: target }), /non-empty/);
}));

test('SIGKILL after a payload write leaves recovery inactive across process restart', (t) => fixture(t, async ({ root, target, archive: input }) => {
  archive(input, [entry('first'), entry('second')]);
  await assert.rejects(exec(process.execPath, [new URL('./helpers/restore-interrupted-child.js', import.meta.url).pathname], {
    env: { ...process.env, U2OS_HOME: target, FIXTURE_ROOT: root, FIXTURE_ARCHIVE: input }, timeout: 10000,
  }), (error) => error.signal === 'SIGKILL');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, RECOVERY_FILE))).status, 'incomplete');
  assert.equal(fs.existsSync(path.join(target, 'first')), true); assert.equal(fs.existsSync(path.join(target, 'second')), false);
  const restarted = await exec(process.execPath, ['--input-type=module', '-e', "import { startServer } from './server/index.js'; try { await startServer({port:0}); process.exitCode=2; } catch(e) { console.log(e.code); }"], {
    env: { ...process.env, U2OS_HOME: target }, timeout: 10000,
  });
  assert.match(restarted.stdout, /RECOVERY_INACTIVE/); assert.equal(fs.existsSync(path.join(target, 'config')), false);
}));
