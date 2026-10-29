import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown } from '../../../server/vault/markdown.js';
import { editVaultFile } from '../../../server/vault/writeback.js';
import { JOB_HUNT_DIR } from '../profile.js';

// The owner's notes for one job: a Markdown file in the vault, `job-hunt/notes/<job-id>.md`, written by the detail panel
// (#634) and editable in any text editor. The file is the source of truth; the API reads it fresh every time and a write
// must name the revision it was based on. Documented in docs/job-hunt.md ("Job notes") and docs/vault.md.
//
//   ---
//   job: job_0123456789abcdef
//   company: Acme
//   role: Staff Engineer
//   updated: 2026-10-29T12:00:00.000Z
//   ---
//   Anything the owner writes, as Markdown.
//
// Properties: the path is derived only from a validated job id (never from client text); symlinked folders and files are
// refused; the body is capped at MAX_NOTE_BYTES; the revision is the SHA-256 of the file's exact bytes, so an edit made in
// an editor changes it; keys other than job, company, role and updated are kept as the owner wrote them; a note that was
// never edited creates no file; the write is atomic (temporary file, then rename) and refuses if the file changed while it
// was prepared. The vault indexer reads only people/, projects/ and commitments/, so notes are not indexed as memory, and
// the journal never holds note text, so a save is not journaled.

export const JOB_ID = /^job_[0-9a-f]{16}$/;
export const NOTES_DIR = `${JOB_HUNT_DIR}/notes`;
export const MAX_NOTE_BYTES = 64 * 1024;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const noteRelativePath = (jobId) => {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw fail('BAD_INPUT', 'Invalid job id');
  return `${NOTES_DIR}/${jobId}.md`;
};

/** The revision of a file's exact text; null when there is no file. */
export const revisionOf = (text) => (text == null ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex'));

/** Refuses a vault where job-hunt or job-hunt/notes is a link or a file. Creates the folders when `create`. */
function ensureNotesDir(vaultDir, create) {
  let dir = vaultDir;
  for (const part of NOTES_DIR.split('/')) {
    dir = path.join(dir, part);
    let stat = null;
    try { stat = fs.lstatSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!create) return false;
      fs.mkdirSync(dir, { mode: 0o700 });
      continue;
    }
    if (!stat.isDirectory()) throw fail('UNSAFE_PATH', `${NOTES_DIR} must be a real folder inside the vault (not a link)`);
  }
  return true;
}

/** The file's raw text, or null when absent. Refuses links, non-files and oversized files. */
function readRaw(vaultDir, relativePath) {
  if (!ensureNotesDir(vaultDir, false)) return null;
  const file = path.join(vaultDir, relativePath);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) throw fail('UNSAFE_PATH', 'The notes file must be a regular file (not a link)');
  if (stat.size > MAX_NOTE_BYTES + 4096) throw fail('NOTE_INVALID', 'The notes file is too large for the app to open; edit it in a text editor');
  return fs.readFileSync(file, 'utf8');
}

function describe(jobId, relativePath, raw) {
  if (raw == null) return { jobId, path: relativePath, exists: false, body: '', revision: null, updatedAt: null, maxBytes: MAX_NOTE_BYTES };
  let parsed;
  try { parsed = parseMarkdown(raw); } catch (error) { throw fail('NOTE_INVALID', `${relativePath} has invalid frontmatter; fix the file first (${error.message})`); }
  const updated = parsed.frontmatter.updated;
  return { jobId, path: relativePath, exists: true, body: parsed.body, revision: revisionOf(raw), updatedAt: typeof updated === 'string' && !Number.isNaN(Date.parse(updated)) ? updated : null, maxBytes: MAX_NOTE_BYTES };
}

/** The current note for a job (freshly read from the file). */
export function readNote(vaultDir, jobId) {
  const relativePath = noteRelativePath(jobId);
  return describe(jobId, relativePath, readRaw(vaultDir, relativePath));
}

/**
 * Saves the note. `revision` is the revision the caller last saw (null when it saw no file); a different current revision
 * throws CONFLICT carrying the current note. job: { id, company, role }. Returns the saved note; an empty body for a note
 * with no file writes nothing, and an unchanged body does not touch the file.
 */
export function writeNote(vaultDir, job, body, revision, { now = new Date() } = {}) {
  const relativePath = noteRelativePath(job?.id);
  if (typeof body !== 'string') throw fail('BAD_INPUT', 'body must be text');
  if (revision !== null && !(typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision))) throw fail('BAD_INPUT', 'revision must be the revision you last read, or null when there was no note');
  if (body.includes('\0')) throw fail('BAD_INPUT', 'body must be text');
  if (Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES) throw fail('TOO_LARGE', `A note can be at most ${MAX_NOTE_BYTES / 1024} KB`);

  const raw = readRaw(vaultDir, relativePath);
  const current = describe(job.id, relativePath, raw);
  if (current.revision !== revision) throw fail('CONFLICT', 'This note changed since you opened it', { note: current });
  const next = body.trim();
  if (!current.exists && !next) return current; // never edited: no file
  if (current.exists && current.body === next) return current;

  ensureNotesDir(vaultDir, true);
  editVaultFile({ vaultDir, relativePath }, (frontmatter) => ({
    frontmatter: { ...frontmatter, job: job.id, company: String(job.company ?? ''), role: String(job.role ?? ''), updated: now.toISOString() },
    body: next,
  }), { create: true });
  return readNote(vaultDir, job.id);
}
