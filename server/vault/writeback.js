import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';
import { getDb } from '../db/connection.js';
import { getVaultDir, ensureVaultLayout } from './vault-dir.js';
import { parseMarkdown, MAX_VAULT_FILE_BYTES } from './markdown.js';

// Writes owner edits made outside the file (Memory UI, accepted memory
// candidates) back into the vault, so the file stays the authority
// (docs/vault.md, ADR 0007). Edits are minimal line changes that keep the
// owner's comments and formatting; if a targeted edit cannot be proven to
// produce exactly the intended document, the frontmatter is re-serialized.
// Writes are atomic and refused if the file changed while being edited.

const RANK = { public: 0, personal: 1, private: 2, sensitive: 3 };
const RESERVED = new Set(['id', 'name', 'title', 'classification', 'sensitive_keys', 'classifications']);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TRASH_DIR = '.trash';

/** The vault file that describes an entity, or null when it is not vault-backed. */
export function vaultTargetForEntity(entityId, { vaultDir = getVaultDir() } = {}) {
  const db = getDb();
  const entity = db.prepare("SELECT id, attributes FROM entities WHERE id = ? AND COALESCE(status, 'active') != 'deleted'").get(entityId);
  if (!entity) return null;
  const ownerEntityId = db.prepare('SELECT entity_id FROM owners WHERE entity_id IS NOT NULL LIMIT 1').get()?.entity_id;
  if (entity.id === ownerEntityId) return { vaultDir, relativePath: 'me.md', owner: true };
  const vaultPath = JSON.parse(entity.attributes || '{}').vaultPath;
  return typeof vaultPath === 'string' ? { vaultDir, relativePath: vaultPath, owner: false } : null;
}

/**
 * Sets `key` to `value` in the entity's file. `previousKey` renames. A
 * requested classification is applied without ever lowering privacy.
 * Returns null when the entity is not vault-backed (database-only memory).
 */
export function writeFactToVault(entityId, { key, value, previousKey = null, classification = undefined, append = false }) {
  const target = vaultTargetForEntity(entityId);
  if (!target) return null;
  assertWritableKey(target, key);
  const note = { effectiveClassification: null };
  editVaultFile(target, (frontmatter, body) => {
    let nextBody = body;
    const fm = { ...frontmatter };
    const previousLevel = previousKey ? keyLevel(fm, previousKey) : undefined;
    if (previousKey && previousKey !== key) {
      if (previousKey === 'notes') nextBody = '';
      else delete fm[previousKey];
      clearKeyLevel(fm, previousKey);
    }
    if (key === 'notes') {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      nextBody = append && nextBody ? `${nextBody}\n\n${text}` : text;
    } else if (key === 'name' && target.owner) {
      fm.name = value;
    } else {
      fm[key] = value;
    }
    const requested = classification ?? (previousKey !== key ? previousLevel : undefined);
    if (requested !== undefined) note.effectiveClassification = applyClassification(fm, key, requested);
    return { frontmatter: tidy(fm), body: nextBody };
  }, { create: target.owner });
  return { path: target.relativePath, ...note };
}

/** Removes `key` from the entity's file; returns null when not vault-backed. */
export function removeFactFromVault(entityId, key) {
  const target = vaultTargetForEntity(entityId);
  if (!target) return null;
  editVaultFile(target, (frontmatter, body) => {
    const fm = { ...frontmatter };
    if (key === 'notes') return { frontmatter: fm, body: '' };
    if (key === 'name' && target.owner) delete fm.name;
    else delete fm[key];
    clearKeyLevel(fm, key);
    return { frontmatter: tidy(fm), body };
  });
  return { path: target.relativePath };
}

/** Applies a classification change for `key`; returns null when not vault-backed. */
export function reclassifyFactInVault(entityId, key, classification) {
  const target = vaultTargetForEntity(entityId);
  if (!target) return null;
  const note = { effectiveClassification: null };
  editVaultFile(target, (frontmatter, body) => {
    const fm = { ...frontmatter };
    note.effectiveClassification = applyClassification(fm, key, classification);
    return { frontmatter: tidy(fm), body };
  });
  return { path: target.relativePath, ...note };
}

/**
 * Moves a deleted record's file to `.trash/` (hidden, so never indexed, and
 * recoverable). The owner's me.md is never moved.
 */
export function prepareVaultTrash(entityId) {
  // Resolved while the record is still active; run after it is deleted.
  const target = vaultTargetForEntity(entityId);
  if (!target || target.owner) return null;
  return () => trashFile(target);
}

function trashFile(target) {
  const source = path.join(target.vaultDir, target.relativePath);
  if (!fs.existsSync(source)) return null;
  const trash = path.join(target.vaultDir, TRASH_DIR);
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(trash, `${stamp}-${target.relativePath.replace(/[\\/]/g, '__')}`);
  fs.renameSync(source, destination);
  return { path: target.relativePath, trashedTo: path.posix.join(TRASH_DIR, path.basename(destination)) };
}

/**
 * Records exactly the level the owner chose for `key`: the file's own
 * `classification` when equal, `sensitive_keys` for sensitive, otherwise a
 * `classifications:` entry. Returns the level the key now has.
 */
export function applyClassification(frontmatter, key, requested) {
  if (!(requested in RANK)) throw writeBackError('classification must be public, personal, private, or sensitive', 400);
  const fileClass = frontmatter.classification in RANK ? frontmatter.classification : 'personal';
  clearKeyLevel(frontmatter, key);
  if (requested === 'sensitive' && fileClass !== 'sensitive') {
    frontmatter.sensitive_keys = [...(Array.isArray(frontmatter.sensitive_keys) ? frontmatter.sensitive_keys : []), key];
  } else if (requested !== fileClass) {
    frontmatter.classifications = { ...(isMapping(frontmatter.classifications) ? frontmatter.classifications : {}), [key]: requested };
  }
  return requested;
}

/** The per-key level recorded in the file, or undefined for the file level. */
function keyLevel(frontmatter, key) {
  if (Array.isArray(frontmatter.sensitive_keys) && frontmatter.sensitive_keys.includes(key)) return 'sensitive';
  return isMapping(frontmatter.classifications) ? frontmatter.classifications[key] : undefined;
}

function clearKeyLevel(frontmatter, key) {
  if (Array.isArray(frontmatter.sensitive_keys)) frontmatter.sensitive_keys = frontmatter.sensitive_keys.filter((item) => item !== key);
  if (isMapping(frontmatter.classifications) && key in frontmatter.classifications) {
    const { [key]: _removed, ...rest } = frontmatter.classifications;
    frontmatter.classifications = rest;
  }
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function editVaultFile({ vaultDir, relativePath }, mutate, { create = false } = {}) {
  ensureVaultLayout(vaultDir);
  const absolute = path.join(vaultDir, relativePath);
  let original = '';
  let mode = 0o600; // new files are private; existing files keep their mode
  try {
    const stat = fs.lstatSync(absolute);
    mode = stat.mode & 0o777;
    if (!stat.isFile()) throw writeBackError('The vault file is not a regular file', 409);
    if (stat.size > MAX_VAULT_FILE_BYTES) throw writeBackError('The vault file is too large to edit', 409);
    original = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) throw writeBackError(`${relativePath} no longer exists; re-index the vault`, 409);
  }
  let parsed;
  try { parsed = parseMarkdown(original); } catch { throw writeBackError(`${relativePath} has invalid frontmatter; fix the file first`, 409); }
  const { frontmatter: nextFrontmatter, body: nextBody } = mutate(parsed.frontmatter, parsed.body);
  const text = render(original, parsed, nextFrontmatter, nextBody);
  const check = parseMarkdown(text);
  if (!isDeepStrictEqual(check.frontmatter, nextFrontmatter) || check.body !== nextBody.trim()) throw writeBackError('Could not produce a valid vault file for this edit', 500);

  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, mode);
  try {
    let current = '';
    try { current = fs.readFileSync(absolute, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== original) throw writeBackError(`${relativePath} changed while being edited; try again`, 409);
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Minimal edit when possible; otherwise a clean re-serialization. */
function render(original, parsed, frontmatter, body) {
  const bodyText = body.trim() ? `${body.trim()}\n` : '';
  const match = original.match(FRONTMATTER);
  if (match) {
    const eol = match[0].includes('\r\n') ? '\r\n' : '\n';
    let lines = match[1].split(/\r?\n/);
    const keys = new Set([...Object.keys(parsed.frontmatter), ...Object.keys(frontmatter)]);
    for (const key of keys) {
      if (isDeepStrictEqual(parsed.frontmatter[key], frontmatter[key])) continue;
      lines = key in frontmatter ? setEntry(lines, key, frontmatter[key]) : removeEntry(lines, key);
    }
    const bodyUnchanged = parsed.body === body.trim();
    const rest = bodyUnchanged ? original.slice(match[0].length) : bodyText;
    const candidate = `---${eol}${lines.join(eol)}${eol}---${eol}${rest}`;
    try {
      const check = parseMarkdown(candidate);
      if (isDeepStrictEqual(check.frontmatter, frontmatter) && check.body === body.trim()) return candidate;
    } catch { /* fall through to a clean rendering */ }
  }
  const dumped = Object.keys(frontmatter).length ? yaml.dump(frontmatter, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true }) : '';
  return `---\n${dumped}---\n${bodyText}`;
}

function entryRange(lines, key) {
  const pattern = new RegExp(`^(?:${escape(key)}|"${escape(key)}"|'${escape(key)}')\\s*:`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^[\s-]/.test(lines[end]))) end++;
  while (end > start + 1 && lines[end - 1] === '') end--;
  return [start, end];
}

function setEntry(lines, key, value) {
  const replacement = yaml.dump({ [key]: value }, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true }).trimEnd().split('\n');
  const range = entryRange(lines, key);
  if (!range) {
    const trimmed = [...lines];
    while (trimmed.length && trimmed.at(-1) === '') trimmed.pop();
    return [...trimmed, ...replacement];
  }
  return [...lines.slice(0, range[0]), ...replacement, ...lines.slice(range[1])];
}

function removeEntry(lines, key) {
  const range = entryRange(lines, key);
  return range ? [...lines.slice(0, range[0]), ...lines.slice(range[1])] : lines;
}

function assertWritableKey(target, key) {
  if (typeof key !== 'string' || !key.trim()) throw writeBackError('key is required', 400);
  if (RESERVED.has(key) && !(key === 'name' && target.owner)) throw writeBackError(`"${key}" is reserved in vault files; edit ${target.relativePath} directly`, 422);
}

function tidy(frontmatter) {
  if (Array.isArray(frontmatter.sensitive_keys) && !frontmatter.sensitive_keys.length) delete frontmatter.sensitive_keys;
  if (isMapping(frontmatter.classifications) && !Object.keys(frontmatter.classifications).length) delete frontmatter.classifications;
  return frontmatter;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function writeBackError(message, status) {
  const error = new Error(message);
  error.code = 'VAULT_WRITEBACK';
  error.status = status;
  return error;
}
