import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt, readEncryptedFile, writeEncryptedFile, generateOrLoadMasterKey } from '../server/security/vault.js';
import { ensureDataDirs } from '../server/db/connection.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-test-'));
}

test('encrypt/decrypt round-trips an object correctly', () => {
  const dir = tempHome();
  try {
    const secret = { apiKey: 'super-secret-value-12345' };
    const encoded = encrypt(secret, dir);
    assert.equal(encoded.v, 1);
    assert.ok(encoded.iv);
    assert.ok(encoded.tag);
    assert.ok(encoded.ciphertext);
    assert.doesNotMatch(JSON.stringify(encoded), /super-secret-value-12345/);

    const decoded = decrypt(encoded, dir);
    assert.deepEqual(decoded, secret);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decrypting a tampered ciphertext/tag throws, never returns garbage', () => {
  const dir = tempHome();
  try {
    const encoded = encrypt({ token: 'abc123' }, dir);

    const tamperedCiphertext = { ...encoded, ciphertext: Buffer.from('tampered-bytes-xxxxx').toString('base64') };
    assert.throws(() => decrypt(tamperedCiphertext, dir));

    const tamperedTag = { ...encoded, tag: Buffer.from('0'.repeat(16)).toString('base64') };
    assert.throws(() => decrypt(tamperedTag, dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('decrypting with the wrong master key throws a clear error', () => {
  const dirA = tempHome();
  const dirB = tempHome();
  try {
    const encoded = encrypt({ hello: 'world' }, dirA);
    assert.throws(() => decrypt(encoded, dirB), /decryption failed/);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('readEncryptedFile/writeEncryptedFile round-trip via <connectorId>.enc.json', () => {
  const dir = tempHome();
  try {
    assert.equal(readEncryptedFile('nonexistent-connector', dir), null);

    writeEncryptedFile('google', { clientId: 'abc', clientSecret: 'shh' }, dir);
    const filePath = path.join(dir, 'credentials', 'google.enc.json');
    assert.ok(fs.existsSync(filePath));
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(raw, /shh/);

    const loaded = readEncryptedFile('google', dir);
    assert.deepEqual(loaded, { clientId: 'abc', clientSecret: 'shh' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('master key file is created once with restrictive permissions', () => {
  const dir = tempHome();
  try {
    const key1 = generateOrLoadMasterKey(dir);
    const keyPath = path.join(dir, 'credentials', 'master.key');
    assert.ok(fs.existsSync(keyPath));

    if (process.platform !== 'win32') {
      const mode = fs.statSync(keyPath).mode & 0o777;
      assert.equal(mode, 0o600);

      // The containing directory must also be 0700, not just the key file --
      // otherwise another local user could at least enumerate which
      // connectors are configured via the *.enc.json filenames (not their
      // contents, but still more than they should see).
      const dirMode = fs.statSync(path.join(dir, 'credentials')).mode & 0o777;
      assert.equal(dirMode, 0o700);
    }

    // Second call loads the same key rather than regenerating it.
    const key2 = generateOrLoadMasterKey(dir);
    assert.deepEqual(key1, key2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDataDirs() never creates credentials/ itself -- only generateOrLoadMasterKey() may, always at 0700', () => {
  // Regression test for a gap caught during deployment-phase Docker
  // verification: server/db/connection.js's generic SUBDIRS loop used to
  // include 'credentials', which meant that directory existed at whatever
  // mkdirSync's default (umask-dependent, often 0755) permissions produced
  // from the moment the server booted, until the first time a real
  // credential was saved triggered vault.js's own 0700 chmod. Empty at that
  // point, so not an active leak, but a real window of laxer-than-intended
  // permissions this test now pins shut: ensureDataDirs() must not create
  // the directory at all, so there is no window where it exists without the
  // correct mode.
  const dir = tempHome();
  try {
    process.env.U2OS_HOME = dir;
    ensureDataDirs();
    assert.equal(
      fs.existsSync(path.join(dir, 'credentials')),
      false,
      'ensureDataDirs() must not create credentials/ -- server/index.js is responsible for calling generateOrLoadMasterKey() at boot instead'
    );

    generateOrLoadMasterKey(dir);
    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(path.join(dir, 'credentials')).mode & 0o777;
      assert.equal(dirMode, 0o700);
    }
  } finally {
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
