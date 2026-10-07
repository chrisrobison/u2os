import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Attachments for email.send (docs/tools.md#email-attachments).
//
// A model (or a routine) can never name a file path. It names a *staged*
// attachment: a file that the owner, or software acting for them, copied into
// the vault outbox under its own SHA-256:
//
//   <vault>/outbox/<sha256 of the content>/<filename>
//
// The reference is `outbox/<sha256>/<filename>`. The send tool re-reads the
// file and checks its hash against the reference, so the content that was
// approved (the reference is part of the approved arguments) is exactly the
// content that is sent. A changed, missing, replaced, linked or oversized file
// fails closed before anything is sent.

export const OUTBOX_DIR = 'outbox';
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

const TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
const REF = /^outbox\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9._ -]{0,98}\.[A-Za-z0-9]{2,5})$/;

/** A safe display and MIME filename: no path separators, controls, quotes or leading dots. */
export function safeFilename(name) {
  const base = path.basename(String(name)).normalize('NFKC').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[._ -]+/, '').slice(0, 100);
  return base || 'attachment';
}

export function isAttachmentRef(value) {
  return typeof value === 'string' && value.length <= 200 && REF.test(value);
}

/** Syntax-only validation, usable before any file is touched (plan time). */
export function assertAttachmentRefs(refs) {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_ATTACHMENTS) throw new Error(`attachments: provide 1 to ${MAX_ATTACHMENTS} staged attachment references`);
  if (new Set(refs).size !== refs.length) throw new Error('attachments: the same attachment is listed twice');
  for (const ref of refs) if (!isAttachmentRef(ref)) throw new Error('attachments: each entry must be a staged reference (outbox/<sha256>/<filename>); file paths are not accepted');
  return refs;
}

/** Copies a file into the outbox, content-addressed, and returns its reference. Idempotent. */
export function stageAttachment(vaultDir, file, { name } = {}) {
  const source = fs.realpathSync(file);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error(`attachments: ${file} is not a regular file`);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('attachments: file is larger than 10 MB');
  const filename = safeFilename(name ?? path.basename(source));
  const extension = path.extname(filename).toLowerCase();
  if (!TYPES[extension]) throw new Error(`attachments: ${extension || 'this'} files cannot be attached (allowed: ${Object.keys(TYPES).join(' ')})`);
  const data = fs.readFileSync(source);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const dir = path.join(vaultDir, OUTBOX_DIR, sha256);
  const target = path.join(dir, filename);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target)) fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
  return { ref: `${OUTBOX_DIR}/${sha256}/${filename}`, filename, sha256, bytes: data.length, contentType: TYPES[extension] };
}

/**
 * Loads one staged attachment, verifying that the file is a regular file
 * inside the outbox (not a link, not reached through one) and that its
 * content still hashes to the reference.
 */
export function resolveAttachment(vaultDir, ref) {
  const match = isAttachmentRef(ref) ? REF.exec(ref) : null;
  if (!match) throw new Error('attachments: not a valid staged attachment reference');
  const [, sha256, filename] = match;
  const root = path.join(vaultDir, OUTBOX_DIR);
  const file = path.join(root, sha256, filename);
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`attachments: ${filename} is not staged; no message was sent`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`attachments: ${filename} is not a regular staged file; no message was sent`);
  let realRoot;
  let realFile;
  try { realRoot = fs.realpathSync(root); realFile = fs.realpathSync(file); } catch { throw new Error(`attachments: ${filename} is not staged; no message was sent`); }
  if (path.dirname(path.dirname(realFile)) !== realRoot) throw new Error(`attachments: ${filename} is outside the outbox; no message was sent`);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachments: ${filename} is larger than 10 MB; no message was sent`);
  const data = fs.readFileSync(realFile);
  if (crypto.createHash('sha256').update(data).digest('hex') !== sha256) throw new Error(`attachments: ${filename} changed after it was staged; no message was sent`);
  const extension = path.extname(filename).toLowerCase();
  if (!TYPES[extension]) throw new Error(`attachments: ${extension} files cannot be attached; no message was sent`);
  return { ref, filename: safeFilename(filename), contentType: TYPES[extension], content: data, bytes: data.length, sha256 };
}

export function resolveAttachments(vaultDir, refs) {
  assertAttachmentRefs(refs);
  const resolved = refs.map((ref) => resolveAttachment(vaultDir, ref));
  if (resolved.reduce((sum, item) => sum + item.bytes, 0) > MAX_TOTAL_BYTES) throw new Error('attachments: total size is larger than 15 MB; no message was sent');
  return resolved;
}

/** What is safe to record or show: no content. */
export const describeAttachments = (resolved) => resolved.map(({ filename, bytes, sha256, contentType }) => ({ filename, bytes, sha256, contentType }));
