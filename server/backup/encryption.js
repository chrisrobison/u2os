import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('U2OSENC1');
const HEADER_SIZE = 52; // magic(8), salt(16), nonce(12), authentication tag(16)
const scrypt = promisify(crypto.scrypt);
// Fixed by format version, not attacker-controlled header cost parameters.
const KDF = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

export function validateBackupPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 4096) {
    throw new Error('snapshot: backup passphrase must contain at least 12 characters and at most 4096 UTF-8 bytes');
  }
}

function readPrefix(file, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(fd, prefix, offset, length - offset, offset);
      if (!count) throw new Error('snapshot: archive is truncated or has an unsupported format');
      offset += count;
    }
    return prefix;
  } finally { fs.closeSync(fd); }
}

function writeAll(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!count) throw new Error('snapshot: unable to write encrypted archive');
    offset += count;
  }
}

export function archiveFormat(file) {
  const prefix = readPrefix(file, MAGIC.length);
  if (prefix.equals(MAGIC)) return 'encrypted';
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) return 'plaintext';
  throw new Error('snapshot: archive is corrupt or has an unsupported format; no extraction was attempted');
}

export async function encryptArchive(source, destination, passphrase) {
  validateBackupPassphrase(passphrase);
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header); crypto.randomBytes(16).copy(header, 8); crypto.randomBytes(12).copy(header, 24);
  const key = await scrypt(passphrase, header.subarray(8, 24), 32, KDF);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, header.subarray(24, 36), { authTagLength: 16 });
    cipher.setAAD(header.subarray(0, 36));
    const fd = fs.openSync(destination, 'wx', 0o600);
    try { writeAll(fd, header, 0); } finally { fs.closeSync(fd); }
    await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(destination, { flags: 'r+', start: HEADER_SIZE }));
    const tagFd = fs.openSync(destination, 'r+');
    try { writeAll(tagFd, cipher.getAuthTag(), 36); }
    finally { fs.closeSync(tagFd); }
  } finally { key.fill(0); }
}

/** Output is unauthenticated until this promise fulfills. The caller must
 * keep it in private staging and must never stream it into tar/extraction. */
export async function decryptArchive(source, destination, passphrase) {
  validateBackupPassphrase(passphrase);
  const header = readPrefix(source, HEADER_SIZE);
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('snapshot: expected an encrypted archive; no extraction was attempted');
  const key = await scrypt(passphrase, header.subarray(8, 24), 32, KDF);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(24, 36), { authTagLength: 16 });
    decipher.setAAD(header.subarray(0, 36)); decipher.setAuthTag(header.subarray(36, 52));
    try {
      await pipeline(fs.createReadStream(source, { start: HEADER_SIZE }), decipher,
        fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if (['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'ENOENT', 'EEXIST'].includes(error.code)) {
        throw new Error('snapshot: unable to stage decrypted archive; check space and permissions. No extraction was attempted');
      }
      throw new Error('snapshot: archive authentication failed; check the passphrase and archive integrity. No extraction was attempted');
    }
  } finally { key.fill(0); }
}
