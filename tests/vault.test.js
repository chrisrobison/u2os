import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt, readEncryptedFile, writeEncryptedFile, generateOrLoadMasterKey } from '../server/security/vault.js';

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
