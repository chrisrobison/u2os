import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from './profile.js';

// The application ledger: one Markdown file per job in the owner's vault
// (job-hunt/applications/). It is the owner's record of every application
// made on their behalf, and what makes applying exactly-once: a job whose
// record says applied or unconfirmed is never submitted again.

export const STATUSES = ['applied', 'unconfirmed', 'needs_answers', 'needs_owner', 'dry_run', 'failed', 'skipped'];
// Statuses after which the server never submits again for that job.
// needs_owner is final too: a blocked submission may or may not have gone
// through, so only the owner (by editing or deleting the record) re-opens it.
export const FINAL = new Set(['applied', 'unconfirmed', 'needs_owner', 'skipped']);

export function applicationsDir(vaultDir) {
  return path.join(vaultDir, JOB_HUNT_DIR, 'applications');
}

export function recordFile(vaultDir, jobId) {
  // Readable, plus a short hash so distinct ids can never share a file.
  const hash = crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 8);
  return path.join(applicationsDir(vaultDir), `${jobId.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 120)}-${hash}.md`);
}

export function readRecord(vaultDir, jobId) {
  const record = parseRecord(recordFile(vaultDir, jobId));
  return record?.job_id === jobId ? record : null;
}

function parseRecord(file) {
  let text;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  try {
    const data = match ? yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) : null;
    return data && typeof data === 'object' ? { ...data, notes: match[2].trim() } : null;
  } catch { return null; }
}

export function listRecords(vaultDir) {
  const dir = applicationsDir(vaultDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('.')); } catch { return []; }
  return names.map((name) => parseRecord(path.join(dir, name))).filter((record) => record?.job_id);
}

/** Writes the record atomically; keeps the owner's own notes in the body. */
export function writeRecord(vaultDir, record, body) {
  const file = recordFile(vaultDir, record.job_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = parseRecord(file);
  const data = { ...(previous ? stripNotes(previous) : {}), ...record, updated_at: new Date().toISOString() };
  const text = `---\n${yaml.dump(data, { lineWidth: 120, noRefs: true })}---\n${body ?? previous?.notes ?? ''}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
  return data;
}

/** Submissions in the last 24 hours, for the daily limit. */
export function submittedInLastDay(vaultDir, now = Date.now()) {
  return listRecords(vaultDir).filter((record) => ['applied', 'unconfirmed', 'needs_owner'].includes(record.status)
    && now - Date.parse(record.applied_at || '') < 86_400_000).length;
}

function stripNotes({ notes: _notes, ...rest }) {
  return rest;
}
