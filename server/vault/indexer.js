import crypto from 'node:crypto';
import path from 'node:path';
import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { recordFact } from '../memory/fact-store.js';
import { COLLECTIONS, getVaultDir, ensureVaultLayout } from './vault-dir.js';
import { listMarkdownFiles, readVaultFile, fileSignature } from './markdown.js';

// Projects owner-authored vault files into the existing entities/facts
// tables (docs/vault.md, ADR 0007). The file is the authority: every row
// written here carries `vault:<relative path>` provenance and can be
// rebuilt from the vault at any time. Records from any other source are
// never modified.

const CLASSIFICATIONS = new Set(['public', 'personal', 'private', 'sensitive']);
const RESERVED_KEYS = new Set(['id', 'name', 'title', 'classification', 'sensitive_keys']);
const ENTITY_ID = /^ent_[A-Za-z0-9_]{1,64}$/;
const COMMITMENT_ATTRIBUTE_KEYS = new Set(['status', 'due']);
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_CHARS = 20_000;
const ME_FILE = 'me.md';

let lastReport = null;

export function vaultEntityId(relativePath) {
  return `ent_vault_${crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 20)}`;
}

export function getLastVaultReport() { return lastReport; }

/**
 * Indexes the whole vault. Deterministic and idempotent: an unchanged vault
 * performs no writes. Each file is applied in its own transaction, and a
 * malformed file is reported and skipped without affecting the others (its
 * previously indexed records are left as they were).
 */
export function indexVault({ eventBus = null, vaultDir = getVaultDir() } = {}) {
  ensureVaultLayout(vaultDir);
  const db = getDb();
  const ownerEntityId = db.prepare('SELECT entity_id FROM owners WHERE entity_id IS NOT NULL LIMIT 1').get()?.entity_id || null;
  const report = { vaultDir, indexedAt: new Date().toISOString(), files: 0, changed: 0, unchanged: 0, removed: 0, errors: [], notes: [] };
  const present = new Set();
  // path -> entity id for files applied in this pass. A file that failed to
  // parse is present but unbound, so its previously indexed records are kept.
  const bound = new Map();

  const sources = [];
  if (fileSignature(vaultDir, ME_FILE)) sources.push({ relativePath: ME_FILE, type: 'Person', owner: true });
  for (const [dir, type] of Object.entries(COLLECTIONS)) {
    for (const relativePath of listMarkdownFiles(vaultDir, dir)) sources.push({ relativePath, type, owner: false });
  }

  for (const source of sources) {
    report.files += 1;
    present.add(source.relativePath);
    if (source.owner && !ownerEntityId) {
      report.notes.push(`${ME_FILE} will be indexed once the owner account exists`);
      continue;
    }
    try {
      const document = readVaultFile(vaultDir, source.relativePath);
      const desired = describe(source, document);
      const entityId = source.owner ? ownerEntityId : resolveEntityId(db, desired, { ownerEntityId, bound });
      const changed = withTransaction(db, () => applyDocument(db, { ...desired, entityId, owner: source.owner, ownerEntityId }));
      bound.set(source.relativePath, entityId);
      if (changed) report.changed += 1; else report.unchanged += 1;
    } catch (error) {
      if (error.code !== 'VAULT_INVALID' && error.code !== 'ENOENT') throw error;
      report.errors.push({ path: source.relativePath, error: error.message });
    }
  }

  report.removed = withTransaction(db, () => removeMissing(db, { present, bound, ownerEntityId }));
  lastReport = report;
  if (eventBus && (report.changed || report.removed)) {
    eventBus.publish({
      type: 'vault.indexed', source: 'vault', actor: { type: 'system', id: 'vault-indexer' },
      data: { files: report.files, changed: report.changed, removed: report.removed, errors: report.errors.length },
    });
  }
  return report;
}

function describe({ relativePath, type }, { frontmatter, body }) {
  const classification = frontmatter.classification ?? 'personal';
  if (!CLASSIFICATIONS.has(classification)) throw invalid('classification must be public, personal, private, or sensitive');
  const sensitiveKeys = frontmatter.sensitive_keys ?? [];
  if (!Array.isArray(sensitiveKeys) || sensitiveKeys.some((key) => typeof key !== 'string')) throw invalid('sensitive_keys must be a list of key names');

  const boundId = frontmatter.id === undefined ? null : String(frontmatter.id);
  if (boundId !== null && !ENTITY_ID.test(boundId)) throw invalid('id must be an existing record id such as ent_abc123');
  const name = scalarText(frontmatter.name) || scalarText(frontmatter.title) || body.match(/^#\s+(.+)$/m)?.[1]?.trim() || humanize(relativePath);
  const attributes = { vaultPath: relativePath };
  const facts = new Map();
  for (const [rawKey, value] of Object.entries(frontmatter)) {
    const key = String(rawKey).trim();
    if (!key || RESERVED_KEYS.has(key) || value === null || value === undefined) continue;
    if (key.length > MAX_KEY_LENGTH) throw invalid(`Key "${key.slice(0, 20)}…" is longer than ${MAX_KEY_LENGTH} characters`);
    if (JSON.stringify(value).length > MAX_VALUE_CHARS) throw invalid(`Value for "${key}" is too large`);
    if (type === 'Commitment' && COMMITMENT_ATTRIBUTE_KEYS.has(key)) attributes[key] = value;
    facts.set(key, { value, classification: sensitiveKeys.includes(key) ? 'sensitive' : classification });
  }
  if (relativePath === ME_FILE && scalarText(frontmatter.name)) facts.set('name', { value: scalarText(frontmatter.name), classification });
  if (body) {
    if (body.length > MAX_VALUE_CHARS) throw invalid('Notes are too large');
    facts.set('notes', { value: body, classification });
  }
  if (type === 'Commitment') {
    attributes.status = attributes.status === undefined ? 'open' : String(attributes.status);
    attributes.description = name;
  }
  return { relativePath, type, name, classification, attributes, facts, boundId };
}

/**
 * A file with `id:` describes an existing record (for example one exported
 * from the database, or imported from contacts) instead of creating a new
 * one, so exporting memory to the vault never duplicates people.
 */
function resolveEntityId(db, { relativePath, boundId }, { ownerEntityId, bound }) {
  const entityId = boundId || vaultEntityId(relativePath);
  if (boundId) {
    if (boundId === ownerEntityId) throw invalid('Describe yourself in me.md; id cannot name the owner');
    if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(boundId)) throw invalid(`id ${boundId} does not match a known record`);
  }
  if ([...bound.values()].includes(entityId)) throw invalid('Another vault file already describes this record');
  return entityId;
}

function applyDocument(db, { relativePath, type, name, classification, attributes, facts, entityId, owner, ownerEntityId, boundId }) {
  const source = `vault:${relativePath}`;
  const now = new Date().toISOString();
  let changed = false;

  if (!owner) {
    const existing = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
    // A bound record keeps attributes other sources gave it (e.g. contacts).
    const encoded = JSON.stringify(boundId && existing ? { ...JSON.parse(existing.attributes || '{}'), ...attributes } : attributes);
    if (!existing) {
      db.prepare('INSERT INTO entities (id, type, name, attributes, status, classification, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(entityId, type, name, encoded, 'active', classification, now, now);
      changed = true;
    } else if (existing.type !== type || existing.name !== name || existing.attributes !== encoded || existing.status !== 'active' || existing.classification !== classification) {
      db.prepare('UPDATE entities SET type = ?, name = ?, attributes = ?, status = ?, classification = ?, deleted_at = NULL, updated_at = ? WHERE id = ?')
        .run(type, name, encoded, 'active', classification, now, entityId);
      changed = true;
    }
    if (type === 'Commitment' && ownerEntityId) changed = ensurePromised(db, { ownerEntityId, entityId, source, classification, now }) || changed;
    // A record is described by exactly one file: retire what an earlier
    // file (before a rename) said about it.
    const retiredFacts = db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE entity_id = ? AND source LIKE 'vault:%' AND source != ? AND status IN ('current', 'disputed')").run(now, entityId, source);
    const retiredRelationships = db.prepare("UPDATE relationships SET status = 'deleted', deleted_at = ? WHERE to_entity_id = ? AND source LIKE 'vault:%' AND source != ? AND status = 'active'").run(now, entityId, source);
    if (retiredFacts.changes || retiredRelationships.changes) changed = true;
  }

  const existingFacts = db.prepare("SELECT * FROM facts WHERE entity_id = ? AND source = ? AND status IN ('current', 'disputed')").all(entityId, source);
  const byKey = new Map();
  for (const fact of existingFacts) {
    if (!byKey.has(fact.key)) byKey.set(fact.key, []);
    byKey.get(fact.key).push(fact);
  }

  for (const [key, { value, classification: factClassification }] of facts) {
    const previous = byKey.get(key) || [];
    byKey.delete(key);
    const encoded = JSON.stringify(value);
    if (previous.length === 1 && previous[0].value === encoded && previous[0].classification === factClassification) continue;
    for (const fact of previous) db.prepare("UPDATE facts SET status = 'superseded' WHERE id = ?").run(fact.id);
    const fact = recordFact({
      entityId, key, value, source, confidence: 1, inferred: false, observedAt: now,
      classification: factClassification, provenance: { vaultPath: relativePath },
    });
    if (previous.length) db.prepare('UPDATE facts SET supersedes_fact_id = ? WHERE id = ?').run(previous[0].id, fact.id);
    changed = true;
  }
  for (const stale of byKey.values()) {
    for (const fact of stale) db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE id = ?").run(now, fact.id);
    changed = true;
  }
  return changed;
}

function ensurePromised(db, { ownerEntityId, entityId, source, classification, now }) {
  const active = db.prepare("SELECT id, source, classification FROM relationships WHERE from_entity_id = ? AND to_entity_id = ? AND relation = 'promised' AND status = 'active'").all(ownerEntityId, entityId);
  const existing = active.find((relationship) => relationship.source === source);
  if (existing?.classification === classification) return false;
  if (existing) {
    db.prepare('UPDATE relationships SET classification = ? WHERE id = ?').run(classification, existing.id);
  } else if (active.some((relationship) => !relationship.source.startsWith('vault:'))) {
    // Already an open commitment of the owner's; never list it twice.
    return false;
  } else {
    db.prepare(`INSERT INTO relationships (id, from_entity_id, relation, to_entity_id, attributes, source, confidence, inferred, observed_at, created_at, classification, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId('rel'), ownerEntityId, 'promised', entityId, '{}', source, 1, 0, now, now, classification, 'active');
  }
  return true;
}

function removeMissing(db, { present, bound, ownerEntityId }) {
  const now = new Date().toISOString();
  let removed = 0;
  const vaultEntities = db.prepare("SELECT id, attributes FROM entities WHERE json_extract(attributes, '$.vaultPath') IS NOT NULL AND status != 'deleted'").all();
  for (const entity of vaultEntities) {
    const attributes = JSON.parse(entity.attributes || '{}');
    const vaultPath = attributes.vaultPath;
    if (bound.get(vaultPath) === entity.id) continue;
    if (present.has(vaultPath) && !bound.has(vaultPath)) continue; // unreadable this pass: keep as is
    db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE entity_id = ? AND source LIKE 'vault:%' AND status IN ('current', 'disputed')").run(now, entity.id);
    db.prepare("UPDATE relationships SET status = 'deleted', deleted_at = ? WHERE to_entity_id = ? AND source LIKE 'vault:%' AND status = 'active'").run(now, entity.id);
    if (entity.id.startsWith('ent_vault_')) {
      db.prepare("UPDATE entities SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, entity.id);
    } else {
      // A pre-existing record the vault only described: keep the record and
      // what other sources know about it, but it is no longer vault-backed.
      delete attributes.vaultPath;
      db.prepare('UPDATE entities SET attributes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(attributes), now, entity.id);
    }
    removed += 1;
  }
  if (ownerEntityId && !present.has(ME_FILE)) {
    const result = db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE entity_id = ? AND source = ? AND status IN ('current', 'disputed')").run(now, ownerEntityId, `vault:${ME_FILE}`);
    if (result.changes) removed += 1;
  }
  return removed;
}

function scalarText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function humanize(relativePath) {
  return path.posix.basename(relativePath, '.md').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'VAULT_INVALID';
  return error;
}
