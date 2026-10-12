import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { appendJournalLine, readJournal } from './journal.js';

// A record, in the vault journal, of every change to the configuration files
// that decide what U2OS may do for the owner (#558). Writers go through
// writeConfigFile(), which records the change and who made it ('api' for the
// UI and API, 'cli' for the command line). Edits made any other way (a text
// editor, another tool) are found by comparing each file with a snapshot kept
// next to the journal and recorded as 'external'.
//
// Entries hold key names and short scalar values only. Anything that looks
// like a credential is redacted, and answers.yaml (the owner's personal
// answers) records key names alone.

export const WATCHED = Object.freeze([
  'policies.yaml', 'mcp.yaml', 'addons.yaml', 'coding-agents.yaml',
  'job-hunt/autopilot.yaml', 'job-hunt/models.yaml', 'job-hunt/answers.yaml',
]);
const KEYS_ONLY = new Set(['job-hunt/answers.yaml']);
const SECRET = /(key|token|secret|password|passphrase|credential|authorization)/i;
const MAX_VALUE = 200;
const MAX_CHANGES = 50;
const CHANNELS = new Set(['api', 'cli', 'external']);

function flatten(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    if (!Object.keys(value).length && prefix) out[prefix] = '{}';
  } else {
    out[prefix || '(root)'] = Array.isArray(value) ? JSON.stringify(value) : value === null || value === undefined ? 'null' : String(value);
  }
  return out;
}

/** The file's settings as { 'dotted.key': 'short value' }, or null when it does not exist. */
export function readConfigValues(vaultDir, file) {
  const target = path.join(vaultDir, file);
  let text;
  try {
    if (!fs.lstatSync(target).isFile()) return { '(file)': 'not a regular file' };
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { '(file)': 'unreadable' };
  }
  let data;
  try { data = yaml.load(text, { schema: yaml.CORE_SCHEMA }); } catch { return { '(file)': 'not valid YAML' }; }
  const values = flatten(data ?? {});
  for (const [key, value] of Object.entries(values)) {
    if (SECRET.test(key)) values[key] = '[redacted]';
    else values[key] = value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
  }
  return values;
}

export function diffConfig(before, after, { keysOnly = false } = {}) {
  const from = before ?? {};
  const to = after ?? {};
  const changes = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (from[key] === to[key]) continue;
    const change = { key };
    if (!keysOnly) {
      if (key in from) change.from = from[key];
      if (key in to) change.to = to[key];
    }
    changes.push(change);
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

const snapshotPath = (vaultDir) => path.join(vaultDir, 'journal', '.config-snapshot.json');

function readSnapshot(vaultDir) {
  try { const data = JSON.parse(fs.readFileSync(snapshotPath(vaultDir), 'utf8')); return data && typeof data === 'object' ? data : null; } catch { return null; }
}
function writeSnapshot(vaultDir, snapshot) {
  fs.mkdirSync(path.dirname(snapshotPath(vaultDir)), { recursive: true });
  fs.writeFileSync(snapshotPath(vaultDir), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

function record(vaultDir, { file, channel, changes, now }) {
  if (!changes.length) return false;
  if (!CHANNELS.has(channel)) throw new Error(`unknown config change channel: ${channel}`);
  const entry = {
    ts: now.toISOString(),
    type: 'config.changed',
    source: channel,
    data: { file, channel, changes: changes.slice(0, MAX_CHANGES), ...(changes.length > MAX_CHANGES ? { more: changes.length - MAX_CHANGES } : {}) },
  };
  appendJournalLine(entry, { vaultDir });
  return true;
}

/**
 * Records any watched file that differs from the snapshot as an 'external'
 * change, then refreshes the snapshot. The first call only takes the baseline.
 * Never throws: the log must not stop the app.
 */
export function checkExternalConfigChanges(vaultDir, { files = WATCHED, now = new Date() } = {}) {
  let recorded = 0;
  try {
    const previous = readSnapshot(vaultDir);
    const snapshot = { ...(previous ?? {}) };
    for (const file of files) {
      const current = readConfigValues(vaultDir, file);
      // A file with no snapshot yet only gets a baseline.
      if (previous && file in previous) {
        const changes = diffConfig(previous[file], current, { keysOnly: KEYS_ONLY.has(file) });
        if (record(vaultDir, { file, channel: 'external', changes, now })) recorded += 1;
      }
      snapshot[file] = current;
    }
    writeSnapshot(vaultDir, snapshot);
  } catch { /* best effort */ }
  return recorded;
}

/**
 * Writes a configuration file and records the change. Anything that changed
 * the file since the last snapshot is recorded first as an external change, so
 * it is not attributed to this write.
 */
export function writeConfigFile(vaultDir, file, text, { channel, now = new Date() } = {}) {
  if (!WATCHED.includes(file)) throw new Error(`${file} is not a watched configuration file`);
  if (!CHANNELS.has(channel)) throw new Error(`unknown config change channel: ${channel}`);
  checkExternalConfigChanges(vaultDir, { files: [file], now });
  const before = readConfigValues(vaultDir, file);
  const target = path.join(vaultDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { mode: 0o600 });
  const after = readConfigValues(vaultDir, file);
  try {
    record(vaultDir, { file, channel, changes: diffConfig(before, after, { keysOnly: KEYS_ONLY.has(file) }), now });
    writeSnapshot(vaultDir, { ...(readSnapshot(vaultDir) ?? {}), [file]: after });
  } catch { /* the write succeeded; the log is best effort */ }
}

/** The most recent recorded change to one file (this month or last), or null. */
export function lastConfigChange(vaultDir, file) {
  const first = readJournal({ limit: 500, vaultDir });
  const find = (entries) => entries.find((entry) => entry.type === 'config.changed' && entry.data?.file === file);
  const hit = find(first.entries);
  if (hit || first.months.length < 2) return hit ?? null;
  return find(readJournal({ month: first.months[1], limit: 500, vaultDir }).entries) ?? null;
}
