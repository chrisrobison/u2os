import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { createBackup, restoreBackup } from '../server/backup/snapshot.js';
import { archiveFormat } from '../server/backup/encryption.js';
import { readBackupPassphrase } from '../server/backup/passphrase.js';
import { writeEncryptedFile, readEncryptedFile } from '../server/security/vault.js';

const exec = promisify(execFile);
const PASSPHRASE = 'fixture-only independent backup passphrase';
async function fixture(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-encryption-test-'));
  const home = path.join(root, 'source'); fs.mkdirSync(home);
  const mktemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (prefix, ...args) => mktemp(/u2os-(?:backup-decrypt|restore-stage)-/.test(String(prefix)) ? path.join(root, 'private-decrypt-') : prefix, ...args));
  try { await run({ root, home, output: path.join(root, 'snapshot.tar.gz.enc') }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function noStaging(root) { assert.equal(fs.readdirSync(root).some((name) => name.startsWith('private-decrypt-') || name.startsWith('.u2os-backup-stage-')), false); }

test('encrypted archive round-trips SQLite/config/credentials without serializing the independent secret', (t) => fixture(t, async ({ root, home, output }) => {
  fs.mkdirSync(path.join(home, 'db')); fs.mkdirSync(path.join(home, 'config'));
  const db = new DatabaseSync(path.join(home, 'db', 'u2os.sqlite'));
  db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, content TEXT); INSERT INTO fixture VALUES (1,'fixture confidential content');"); db.close();
  fs.writeFileSync(path.join(home, 'config', 'fixture.json'), '{"ownerConstraints":"fixture private criteria"}');
  writeEncryptedFile('fixture-secret', { token: 'fixture account token' }, home);
  await createBackup({ dataDir: home, outputPath: output, encrypted: true, passphrase: PASSPHRASE });
  assert.equal(archiveFormat(output), 'encrypted');
  const bytes = fs.readFileSync(output);
  for (const secret of [PASSPHRASE, 'fixture confidential content', 'fixture private criteria', 'fixture account token', 'credentials/master.key']) assert.ok(!bytes.includes(Buffer.from(secret)));
  assert.equal(bytes.subarray(0, 8).toString(), 'U2OSENC1');
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const destination = path.join(root, 'isolated-restore');
  await restoreBackup({ archivePath: output, dataDir: destination, passphrase: PASSPHRASE });
  const restored = new DatabaseSync(path.join(destination, 'db', 'u2os.sqlite'), { readOnly: true });
  try { assert.equal(restored.prepare('SELECT content FROM fixture WHERE id = 1').get().content, 'fixture confidential content'); }
  finally { restored.close(); }
  assert.deepEqual(readEncryptedFile('fixture-secret', destination), { token: 'fixture account token' });
  assert.equal(fs.readFileSync(path.join(destination, 'config', 'fixture.json'), 'utf8'), '{"ownerConstraints":"fixture private criteria"}');
  noStaging(root);
}));

for (const failure of ['wrong passphrase', 'ciphertext', 'salt', 'nonce', 'tag', 'magic', 'truncated header', 'truncated payload']) {
  test(`encrypted restore rejects ${failure} before target mutation, even with force`, (t) => fixture(t, async ({ root, home, output }) => {
    fs.writeFileSync(path.join(home, 'fixture.txt'), 'Fixture data to protect');
    await createBackup({ dataDir: home, outputPath: output, passphrase: PASSPHRASE });
    const original = fs.readFileSync(output);
    const changed = Buffer.from(original);
    const positions = { ciphertext: 52, salt: 8, nonce: 24, tag: 36, magic: 0 };
    if (Object.hasOwn(positions, failure)) changed[positions[failure]] ^= 1;
    const input = path.join(root, 'tampered.enc');
    fs.writeFileSync(input, failure === 'truncated header' ? changed.subarray(0, 30) : failure === 'truncated payload' ? changed.subarray(0, changed.length - 1) : changed);
    const destination = path.join(root, 'existing-target'); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'owner-record'), 'Preserve my fixture record');
    await assert.rejects(restoreBackup({ archivePath: input, dataDir: destination, force: true, encrypted: true,
      passphrase: failure === 'wrong passphrase' ? 'fixture-only wrong independent passphrase' : PASSPHRASE }),
    /authentication failed|unsupported format|expected an encrypted archive/);
    assert.deepEqual(fs.readdirSync(destination), ['owner-record']);
    assert.equal(fs.readFileSync(path.join(destination, 'owner-record'), 'utf8'), 'Preserve my fixture record');
    assert.deepEqual(fs.readFileSync(output), original);
    assert.equal(fs.readFileSync(path.join(home, 'fixture.txt'), 'utf8'), 'Fixture data to protect');
    noStaging(root);
  }));
}

test('encrypted creation uses new salt/nonce and cannot publish without a valid independent passphrase', (t) => fixture(t, async ({ root, home, output }) => {
  fs.writeFileSync(path.join(home, 'fixture.txt'), 'Same fixture contents');
  await assert.rejects(createBackup({ dataDir: home, outputPath: output, encrypted: true }), /backup passphrase/);
  assert.equal(fs.existsSync(output), false);
  await createBackup({ dataDir: home, outputPath: output, passphrase: PASSPHRASE });
  const second = path.join(root, 'second.enc'); await createBackup({ dataDir: home, outputPath: second, passphrase: PASSPHRASE });
  assert.notDeepEqual(fs.readFileSync(output).subarray(8, 36), fs.readFileSync(second).subarray(8, 36));
  await assert.rejects(createBackup({ dataDir: home, outputPath: output, passphrase: PASSPHRASE }), /already exists/);
  noStaging(root);
}));

test('multi-megabyte encryption/restore streams the archive and reads only bounded headers synchronously', (t) => fixture(t, async ({ root, home, output }) => {
  const content = path.join(home, 'fixture-stream.bin');
  const fd = fs.openSync(content, 'wx', 0o600);
  const chunk = Buffer.alloc(64 * 1024);
  const hash = crypto.createHash('sha256');
  try {
    for (let index = 0; index < 64; index += 1) { crypto.randomFillSync(chunk); hash.update(chunk); fs.writeSync(fd, chunk); }
  } finally { fs.closeSync(fd); }
  const expected = hash.digest('hex');
  const readFile = fs.readFileSync, read = fs.readSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.ok(!String(file).includes('.tar.gz'), 'never buffer an archive with readFileSync');
    return readFile(file, ...args);
  });
  t.mock.method(fs, 'readSync', (handle, buffer, offset, length, position) => {
    assert.ok(length <= 52, 'synchronous archive reads are header-only');
    return read(handle, buffer, offset, length, position);
  });
  await createBackup({ dataDir: home, outputPath: output, passphrase: PASSPHRASE });
  assert.ok(fs.statSync(output).size > 4 * 1024 * 1024);
  const target = path.join(root, 'stream-isolated-restore');
  await restoreBackup({ archivePath: output, dataDir: target, passphrase: PASSPHRASE });
  const observed = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(path.join(target, 'fixture-stream.bin'))) observed.update(bytes);
  assert.equal(observed.digest('hex'), expected); noStaging(root);
}));

test('plaintext compatibility never satisfies an explicit encrypted expectation', (t) => fixture(t, async ({ root, home, output }) => {
  fs.writeFileSync(path.join(home, 'fixture.txt'), 'Legacy fixture data');
  const legacy = path.join(root, 'legacy.tar.gz'); await createBackup({ dataDir: home, outputPath: legacy });
  assert.equal(archiveFormat(legacy), 'plaintext');
  const rejected = path.join(root, 'must-not-be-created');
  await assert.rejects(restoreBackup({ archivePath: legacy, dataDir: rejected, passphrase: PASSPHRASE }), /expected an encrypted archive/);
  assert.equal(fs.existsSync(rejected), false);
  await restoreBackup({ archivePath: legacy, dataDir: path.join(root, 'isolated-legacy') });
  assert.equal(fs.readFileSync(path.join(root, 'isolated-legacy', 'fixture.txt'), 'utf8'), 'Legacy fixture data');
  noStaging(root);
}));

test('CLI encryption uses an explicit environment secret, labels plaintext compatibility, and never accepts secret arguments', (t) => fixture(t, async ({ root, home, output }) => {
  fs.writeFileSync(path.join(home, 'fixture.txt'), 'CLI fixture');
  const script = fileURLToPath(new URL('../server/backup/snapshot.js', import.meta.url));
  const env = { ...process.env, U2OS_HOME: home, U2OS_BACKUP_PASSPHRASE: PASSPHRASE };
  const made = await exec(process.execPath, [script, 'backup', '--encrypt', output], { env, timeout: 10000 });
  assert.match(made.stdout, /ENCRYPTED archive/); assert.ok(!`${made.stdout}${made.stderr}`.includes(PASSPHRASE));
  const target = path.join(root, 'cli-isolated-restore');
  const restored = await exec(process.execPath, [script, 'restore', output, '--encrypt'], { env: { ...env, U2OS_HOME: target }, timeout: 10000 });
  assert.ok(!`${restored.stdout}${restored.stderr}`.includes(PASSPHRASE));
  assert.equal(fs.readFileSync(path.join(target, 'fixture.txt'), 'utf8'), 'CLI fixture');
  await assert.rejects(exec(process.execPath, [script, 'backup', '--passphrase', PASSPHRASE], { env }), (error) => {
    assert.match(error.stderr, /Never pass a passphrase as an argument/); assert.ok(!error.stderr.includes(PASSPHRASE)); return true;
  });
  const noSecret = { ...env }; delete noSecret.U2OS_BACKUP_PASSPHRASE;
  await assert.rejects(exec(process.execPath, [script, 'backup', '--encrypt', path.join(root, 'missing-secret.enc')], { env: noSecret }), /terminal for masked/);
  const legacy = path.join(root, 'cli-legacy.tar.gz');
  const plain = await exec(process.execPath, [script, 'backup', legacy], { env: noSecret });
  assert.match(plain.stdout, /UNENCRYPTED archive/);
  noStaging(root);
}));

function terminal() {
  const input = new PassThrough(); input.isTTY = true;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new PassThrough(); let transcript = '';
  output.on('data', (chunk) => { transcript += chunk; });
  const type = (value) => { input.emit('keypress', value, {}); input.emit('keypress', '\r', { name: 'return' }); };
  return { input, output, type, transcript: () => transcript };
}

test('masked prompt confirms independent input and restores terminal state without echo', async () => {
  const io = terminal();
  const pending = readBackupPassphrase({ confirm: true, env: {}, input: io.input, output: io.output });
  io.type(PASSPHRASE); await Promise.resolve(); io.type(PASSPHRASE);
  assert.equal(await pending, PASSPHRASE);
  assert.ok(!io.transcript().includes(PASSPHRASE));
  assert.equal(io.input.isRaw, false); assert.equal(io.input.listenerCount('keypress'), 0);
});

test('masked cancellation, EOF and mismatched confirmation do not expose secrets or retain listeners', async () => {
  for (const failure of ['cancel', 'end', 'mismatch']) {
    const io = terminal();
    const pending = readBackupPassphrase({ confirm: true, env: {}, input: io.input, output: io.output });
    if (failure === 'cancel') io.input.emit('keypress', '', { ctrl: true, name: 'c' });
    else if (failure === 'end') io.input.emit('end');
    else { io.type(PASSPHRASE); await Promise.resolve(); io.type('different fixture-only passphrase'); }
    await assert.rejects(pending, /cancelled|input ended|do not match/);
    assert.ok(!io.transcript().includes(PASSPHRASE)); assert.equal(io.input.isRaw, false);
    assert.equal(io.input.listenerCount('keypress'), 0);
  }
  const env = { U2OS_BACKUP_PASSPHRASE: PASSPHRASE };
  assert.equal(await readBackupPassphrase({ env }), PASSPHRASE); assert.equal(env.U2OS_BACKUP_PASSPHRASE, undefined);
});
