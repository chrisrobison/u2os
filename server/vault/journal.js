import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logging/logger.js';
import { getVaultDir } from './vault-dir.js';

// An append-only record, in the owner's vault, of what U2OS did on their
// behalf and what they decided (docs/vault.md, #360). One JSON object per
// line in journal/YYYY-MM.jsonl. Entries carry types, identifiers and a few
// allowlisted metadata fields, never message bodies, arguments, provider
// errors or memory values: the database keeps the detail, the journal keeps
// the owner's own history of it. Journal failures never affect the event.

const JOURNALED = new Set([
  'routine.fired', 'routine.completed', 'routine.failed',
  'agent.action.proposed', 'agent.action.approved', 'agent.action.rejected', 'agent.action.completed', 'agent.action.failed',
  'email.sent', 'notification.sent', 'task.created', 'task.completed',
  'agent.memory_candidate.proposed', 'agent.memory_candidate.rejected',
  'memory.fact_recorded', 'memory.fact_corrected', 'memory.fact_reclassified', 'memory.fact_deleted', 'memory.entity_deleted',
  'commitment.made',
]);
// Only these data fields are copied, and only when they are short scalars.
const DATA_FIELDS = ['tool', 'routine', 'routineRunId', 'runId', 'trigger', 'slot', 'eventId', 'pendingApprovals', 'entityId', 'key', 'previousFactId', 'memoryCandidateId', 'candidateId', 'relation'];
const REASON_CODE = /^[a-z_]{1,64}$|^[A-Z_]{1,64}$/;
const MAX_FIELD = 200;

export function journalEntry(event) {
  if (!JOURNALED.has(event?.type)) return null;
  const data = {};
  for (const field of DATA_FIELDS) {
    const value = event.data?.[field];
    if ((typeof value === 'string' && value.length <= MAX_FIELD) || typeof value === 'number' || typeof value === 'boolean') data[field] = value;
  }
  // Routine failure reasons are error codes by construction; other reasons
  // may contain provider text and are left out.
  if (event.type.startsWith('routine.') && REASON_CODE.test(event.data?.reason || '')) data.reason = event.data.reason;
  return {
    ts: event.timestamp,
    type: event.type,
    source: event.source,
    ...(event.actor ? { actor: { type: event.actor.type, id: event.actor.id } } : {}),
    ...(event.subject ? { subject: { type: event.subject.type, id: event.subject.id } } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    eventId: event.id,
    ...(Object.keys(data).length ? { data } : {}),
  };
}

export function journalPath(timestamp, vaultDir = getVaultDir()) {
  const date = new Date(timestamp);
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(vaultDir, 'journal', `${month}.jsonl`);
}

export function appendToJournal(event, { vaultDir = getVaultDir() } = {}) {
  const entry = journalEntry(event);
  if (!entry) return false;
  const file = journalPath(entry.ts || Date.now(), vaultDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('journal file is not a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return true;
}

/** Subscribes the journal to the event bus; returns an unsubscribe function. */
export function startJournal({ eventBus }) {
  let warned = false;
  return eventBus.subscribe('*', (event) => {
    try { appendToJournal(event); }
    catch {
      // Never let the journal break event delivery; say so once per run.
      if (!warned) { warned = true; log.warn('journal', 'Could not append to the vault journal; entries are being skipped'); }
    }
  });
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Recent journal entries for the owner-only UI: one month (default the
 * latest), newest first. Lines that are not valid JSON are skipped; a very
 * large month is read from its end.
 */
export function readJournal({ month = null, limit = 100, vaultDir = getVaultDir() } = {}) {
  const dir = path.join(vaultDir, 'journal');
  let months = [];
  try { months = fs.readdirSync(dir).filter((name) => MONTH.test(name.replace(/\.jsonl$/, '')) && name.endsWith('.jsonl')).map((name) => name.slice(0, 7)).sort().reverse(); } catch { /* no journal yet */ }
  if (month !== null && !MONTH.test(month)) throw Object.assign(new Error('month must look like 2026-09'), { code: 'INVALID_MONTH' });
  const selected = month || months[0] || null;
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  if (!selected || !months.includes(selected)) return { months, month: selected, entries: [] };
  const file = path.join(dir, `${selected}.jsonl`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return { months, month: selected, entries: [] };
  let text;
  if (stat.size > MAX_READ_BYTES) {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      text = buffer.toString('utf8').split('\n').slice(1).join('\n'); // drop the partial first line
    } finally { fs.closeSync(fd); }
  } else {
    text = fs.readFileSync(file, 'utf8');
  }
  const entries = [];
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0 && entries.length < max; index--) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); } catch { /* skip a damaged line */ }
  }
  return { months, month: selected, entries };
}
