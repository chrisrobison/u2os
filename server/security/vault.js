// Credential vault: AES-256-GCM encryption at rest for every connector
// secret (OAuth client id/secret, tokens, API keys, webhook URLs), backed by
// a single local master key. Per docs/connectors.md's "Credential
// encryption" section.
//
// SECURITY: never log a decrypted credential/token/key anywhere, including
// error messages -- errors below reference the connector id only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from '../db/connection.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function credentialsDir(dataDir = getDataDir()) {
  return path.join(dataDir, 'credentials');
}

function masterKeyPath(dataDir = getDataDir()) {
  return path.join(credentialsDir(dataDir), 'master.key');
}

function encryptedFilePath(connectorId, dataDir = getDataDir()) {
  return path.join(credentialsDir(dataDir), `${connectorId}.enc.json`);
}

// SECURITY: this directory holds the master key and every connector's
// encrypted secrets. `mkdirSync`'s `mode` option is still subject to the
// process umask (commonly 022), so a bare `{ recursive: true }` can leave it
// world-readable (0755) -- an unprivileged local user could then at least
// enumerate which connectors are configured (filenames only, not contents,
// since the files themselves are independently 0600 and encrypted). Force
// 0700 explicitly, the same belt-and-suspenders pattern already used for
// master.key below (mode option + follow-up chmodSync, best-effort on
// platforms where chmod is a no-op).
function ensureCredentialsDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms where chmod is a no-op
  }
}

/**
 * Generates ~/.u2os/credentials/master.key (32 random bytes) on first use,
 * mode 0o600. Subsequent calls just load the existing key. Idempotent, safe
 * to call on every encrypt/decrypt.
 */
export function generateOrLoadMasterKey(dataDir = getDataDir()) {
  const dir = credentialsDir(dataDir);
  ensureCredentialsDir(dir);
  const keyPath = masterKeyPath(dataDir);
  if (!fs.existsSync(keyPath)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // best-effort on platforms where chmod is a no-op
    }
    return key;
  }
  return fs.readFileSync(keyPath);
}

/**
 * AES-256-GCM encrypt an arbitrary JSON-serializable object. Returns
 * { v: 1, iv, tag, ciphertext } with iv/tag/ciphertext base64-encoded, ready
 * to be JSON.stringify'd to a *.enc.json file.
 */
export function encrypt(plainObject, dataDir = getDataDir()) {
  const key = generateOrLoadMasterKey(dataDir);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plainObject ?? {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypts the { v, iv, tag, ciphertext } shape produced by encrypt() back
 * into the original object. Throws a clear, secret-free error if the master
 * key doesn't match or the ciphertext/tag has been tampered with -- GCM's
 * auth tag check fails closed, never returning garbage.
 */
export function decrypt(fileContents, dataDir = getDataDir()) {
  if (!fileContents || typeof fileContents !== 'object') {
    throw new Error('vault: cannot decrypt -- malformed encrypted payload');
  }
  const { iv, tag, ciphertext } = fileContents;
  if (!iv || !tag || !ciphertext) {
    throw new Error('vault: cannot decrypt -- malformed encrypted payload');
  }
  const key = generateOrLoadMasterKey(dataDir);
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('vault: decryption failed -- master key mismatch or corrupted/tampered credential file');
  }
}

/** Reads & decrypts ~/.u2os/credentials/<connectorId>.enc.json. Returns null
 * (not an error) if the file doesn't exist yet -- "not configured" is a
 * normal, expected state for every connector until the owner connects it. */
export function readEncryptedFile(connectorId, dataDir = getDataDir()) {
  const filePath = encryptedFilePath(connectorId, dataDir);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return decrypt(raw, dataDir);
}

/** Encrypts and writes plainObject to ~/.u2os/credentials/<connectorId>.enc.json. */
export function writeEncryptedFile(connectorId, plainObject, dataDir = getDataDir()) {
  const dir = credentialsDir(dataDir);
  ensureCredentialsDir(dir);
  const encoded = encrypt(plainObject, dataDir);
  const filePath = encryptedFilePath(connectorId, dataDir);
  fs.writeFileSync(filePath, JSON.stringify(encoded), { mode: 0o600 });
  return plainObject;
}
