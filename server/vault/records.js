import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS, getVaultDir, ensureVaultLayout } from './vault-dir.js';
import { editVaultFile, vaultTargetForEntity, writeBackError } from './writeback.js';
import { vaultEntityId } from './indexer.js';
import { readVaultFile } from './markdown.js';

// Creates and edits whole vault records (people, projects) from the browser
// (#438, #439). The file stays the authority (ADR 0007): it is written first,
// atomically and never over an existing file, then the caller re-indexes.
//
// Only the fields below can be set from here. Anything else a file contains,
// including `id`, `classification`, `sensitive_keys` and `classifications`, is
// left exactly as the owner wrote it.

const FOLDER_FOR_TYPE = Object.freeze(Object.fromEntries(Object.entries(COLLECTIONS).map(([dir, type]) => [type, dir])));

export const RECORD_FIELDS = Object.freeze({
  Person: Object.freeze({
    email: { max: 320 },
    phone: { max: 64 },
    relationship: { max: 100 },
    organization: { max: 200 },
    birthday: { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, date: true, message: 'must be a date like 1990-05-01' },
    keep_in_touch_days: { max: 4, pattern: /^\d{1,4}$/, message: 'must be a whole number of days', number: true },
    last_contact: { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, date: true, message: 'must be a date like 2026-10-05' },
  }),
  Project: Object.freeze({
    status: { max: 32, oneOf: ['active', 'planned', 'blocked', 'paused', 'done'] },
    deadline: { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, date: true, message: 'must be a date like 2026-12-31' },
  }),
});

const MAX_NAME = 200;
const MAX_NOTES = 20_000;
const MAX_SLUG = 60;

export function slugify(name) {
  const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/g, '');
  return slug || 'untitled';
}

function invalid(message) {
  return writeBackError(message, 400);
}

// Returns { name, fields, notes } with trimmed, validated values. `fields`
// holds only keys that were supplied; an empty string means "clear it".
export function validateRecord(type, input = {}, { partial = false } = {}) {
  const allowed = Object.hasOwn(RECORD_FIELDS, type) ? RECORD_FIELDS[type] : null;
  if (!allowed) throw invalid(`Unsupported record type: ${type}`);
  const out = { fields: {} };

  if (input.name !== undefined || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw invalid('name is required');
    if (name.length > MAX_NAME) throw invalid(`name must be at most ${MAX_NAME} characters`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('name must not contain control characters');
    out.name = name;
  }

  for (const [key, value] of Object.entries(input.fields || {})) {
    // Own properties only: `constructor` and `toString` are not fields.
    const rule = Object.hasOwn(allowed, key) ? allowed[key] : null;
    if (!rule) throw invalid(`"${key}" is not a field of a ${type}`);
    if (value === null || value === '') { out.fields[key] = ''; continue; }
    if (typeof value !== 'string') throw invalid(`${key} must be text`);
    const text = value.trim();
    if (text.length > rule.max) throw invalid(`${key} must be at most ${rule.max} characters`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw invalid(`${key} must not contain control characters`);
    if (rule.oneOf && !rule.oneOf.includes(text)) throw invalid(`${key} must be one of: ${rule.oneOf.join(', ')}`);
    if (rule.pattern && !rule.pattern.test(text)) throw invalid(`${key} ${rule.message}`);
    if (rule.date && !isRealDate(text)) throw invalid(`${key} ${rule.message}`);
    out.fields[key] = rule.number ? Number(text) : text;
  }

  if (input.notes !== undefined) {
    if (input.notes !== null && typeof input.notes !== 'string') throw invalid('notes must be text');
    const notes = (input.notes || '').trim();
    if (notes.length > MAX_NOTES) throw invalid(`notes must be at most ${MAX_NOTES} characters`);
    out.notes = notes;
  }
  return out;
}

// 2026-02-31 matches the pattern but is not a day, and some engines roll it
// into March instead of rejecting it.
function isRealDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function applyFields(frontmatter, fields) {
  const next = { ...frontmatter };
  for (const [key, value] of Object.entries(fields)) {
    if (value === '') delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Creates a new record file. Never overwrites: a name that is already taken
 * gets a numeric suffix. Returns { path, entityId }; the caller re-indexes.
 */
export function createVaultRecord(type, input, { vaultDir = getVaultDir() } = {}) {
  const dir = FOLDER_FOR_TYPE[type];
  const record = validateRecord(type, input);
  ensureVaultLayout(vaultDir);
  const base = slugify(record.name);

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const file = `${attempt === 1 ? base : `${base}-${attempt}`}.md`;
    const relativePath = path.posix.join(dir, file);
    const absolute = path.join(vaultDir, relativePath);
    // The slug has no separators, so this only guards against surprises.
    if (path.dirname(absolute) !== path.join(vaultDir, dir)) throw writeBackError('Invalid file name', 400);
    if (fs.existsSync(absolute)) continue;
    editVaultFile({ vaultDir, relativePath }, () => ({
      frontmatter: applyFields({ name: record.name }, record.fields),
      body: record.notes || '',
    }), { create: true });
    return { path: relativePath, entityId: vaultEntityId(relativePath) };
  }
  throw writeBackError('Too many records share this name; choose a different name', 409);
}

/**
 * Edits the supplied fields of an existing vault-backed record in one atomic
 * write. Returns null when the record has no vault file (database-only
 * memory) so the caller can say so; the owner's me.md is not editable here.
 */
export function updateVaultRecord(entityId, type, input, { vaultDir = getVaultDir() } = {}) {
  const target = vaultTargetForEntity(entityId, { vaultDir });
  if (!target || target.owner) return null;
  const record = validateRecord(type, input, { partial: true });
  editVaultFile(target, (frontmatter, body) => {
    const next = applyFields(frontmatter, record.fields);
    if (record.name !== undefined) next.name = record.name;
    return { frontmatter: next, body: record.notes !== undefined ? record.notes : body };
  });
  return { path: target.relativePath, entityId };
}

/**
 * What the file says today, for the edit dialog. The file is the authority,
 * so the form shows it rather than the database's copy. Returns null when the
 * record has no vault file.
 */
export function readVaultRecord(entityId, type, { vaultDir = getVaultDir() } = {}) {
  const target = vaultTargetForEntity(entityId, { vaultDir });
  if (!target || target.owner) return null;
  const { frontmatter, body } = readVaultFile(vaultDir, target.relativePath);
  const fields = {};
  for (const key of Object.keys(RECORD_FIELDS[type] || {})) {
    const value = frontmatter[key];
    if (value !== undefined && value !== null) fields[key] = String(value);
  }
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : null;
  return { path: target.relativePath, name, fields, notes: body };
}
