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
const RESERVED_KEYS = new Set(['name', 'title', 'classification', 'sensitive_keys']);
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
      const changed = withTransaction(db, () => applyDocument(db, {
        ...desired, entityId: source.owner ? ownerEntityId : vaultEntityId(source.relativePath), owner: source.owner, ownerEntityId,
      }));
      if (changed) report.changed += 1; else report.unchanged += 1;
    } catch (error) {
      if (error.code !== 'VAULT_INVALID' && error.code !== 'ENOENT') throw error;
      report.errors.push({ path: source.relativePath, error: error.message });
    }
  }

  report.removed = withTransaction(db, () => removeMissing(db, present, ownerEntityId));
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
  return { relativePath, type, name, classification, attributes, facts };
}

function applyDocument(db, { relativePath, type, name, classification, attributes, facts, entityId, owner, ownerEntityId }) {
  const source = `vault:${relativePath}`;
  const now = new Date().toISOString();
  let changed = false;

  if (!owner) {
    const existing = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
    const encoded = JSON.stringify(attributes);
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
  const existing = db.prepare("SELECT id, classification FROM relationships WHERE from_entity_id = ? AND to_entity_id = ? AND relation = 'promised' AND source = ? AND status = 'active'").get(ownerEntityId, entityId, source);
  if (existing?.classification === classification) return false;
  if (existing) {
    db.prepare('UPDATE relationships SET classification = ? WHERE id = ?').run(classification, existing.id);
  } else {
    db.prepare(`INSERT INTO relationships (id, from_entity_id, relation, to_entity_id, attributes, source, confidence, inferred, observed_at, created_at, classification, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId('rel'), ownerEntityId, 'promised', entityId, '{}', source, 1, 0, now, now, classification, 'active');
  }
  return true;
}

function removeMissing(db, present, ownerEntityId) {
  const now = new Date().toISOString();
  let removed = 0;
  const vaultEntities = db.prepare("SELECT id, attributes FROM entities WHERE substr(id, 1, 10) = 'ent_vault_' AND status != 'deleted'").all();
  for (const entity of vaultEntities) {
    const vaultPath = JSON.parse(entity.attributes || '{}').vaultPath;
    if (present.has(vaultPath)) continue;
    db.prepare("UPDATE entities SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, entity.id);
    db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE entity_id = ? AND source LIKE 'vault:%' AND status IN ('current', 'disputed')").run(now, entity.id);
    db.prepare("UPDATE relationships SET status = 'deleted', deleted_at = ? WHERE to_entity_id = ? AND source LIKE 'vault:%' AND status = 'active'").run(now, entity.id);
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
