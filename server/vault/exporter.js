import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDb } from '../db/connection.js';
import { COLLECTIONS, getVaultDir, ensureVaultLayout } from './vault-dir.js';
import { listMarkdownFiles, readVaultFile } from './markdown.js';
import { policiesPath, ensureDefaultPolicies } from '../policy/policies-loader.js';

// One-shot migration of database memory into owned vault files (#359,
// docs/vault.md). Each file carries `id:` so re-indexing describes the same
// record instead of creating a duplicate. Existing files are never
// overwritten and no database record is deleted.

const RANK = { public: 0, personal: 1, private: 2, sensitive: 3 };
const RESERVED = new Set(['id', 'name', 'title', 'classification', 'sensitive_keys', 'classifications', 'notes']);
const DIR_FOR_TYPE = Object.fromEntries(Object.entries(COLLECTIONS).map(([dir, type]) => [type, dir]));

export function exportMemoryToVault({ vaultDir = getVaultDir() } = {}) {
  ensureVaultLayout(vaultDir);
  const db = getDb();
  const ownerEntityId = db.prepare('SELECT entity_id FROM owners WHERE entity_id IS NOT NULL LIMIT 1').get()?.entity_id || null;
  const report = { vaultDir, written: [], skippedExisting: [], inferredFactsLeftOut: 0, reservedKeysLeftOut: 0 };
  exportPolicies(vaultDir, report);
  const taken = new Set();
  const describedIds = idsAlreadyInVault(vaultDir);

  if (ownerEntityId) {
    const owner = db.prepare('SELECT * FROM entities WHERE id = ?').get(ownerEntityId);
    if (owner) writeRecord(db, vaultDir, 'me.md', owner, { owner: true, report });
  }

  const types = Object.keys(DIR_FOR_TYPE).map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM entities WHERE type IN (${types}) AND COALESCE(status, 'active') != 'deleted'
    AND json_extract(attributes, '$.vaultPath') IS NULL AND id != ? ORDER BY created_at, rowid`).all(...Object.keys(DIR_FOR_TYPE), ownerEntityId || '');
  for (const entity of rows) {
    if (describedIds.has(entity.id)) { report.skippedExisting.push(describedIds.get(entity.id)); continue; }
    const relativePath = uniquePath(vaultDir, DIR_FOR_TYPE[entity.type], entity, taken);
    writeRecord(db, vaultDir, relativePath, entity, { owner: false, report });
  }
  return report;
}

function writeRecord(db, vaultDir, relativePath, entity, { owner, report }) {
  const facts = db.prepare("SELECT * FROM facts WHERE entity_id = ? AND status = 'current' AND source NOT LIKE 'vault:%' ORDER BY created_at, rowid").all(entity.id);
  const frontmatter = {};
  if (!owner) frontmatter.id = entity.id;
  if (entity.name) frontmatter.name = entity.name;

  const kept = [];
  for (const fact of facts) {
    if (fact.inferred) { report.inferredFactsLeftOut += 1; continue; }
    if (RESERVED.has(fact.key) && fact.key !== 'notes') { report.reservedKeysLeftOut += 1; continue; }
    kept.push(fact);
  }
  // Preserve every fact's classification exactly: the file carries the
  // entity's level, and facts that differ are listed per key.
  const classification = RANK[entity.classification] !== undefined ? entity.classification : 'personal';
  frontmatter.classification = classification;
  const sensitiveKeys = [];
  const perKey = {};
  for (const fact of kept) {
    if (fact.classification === classification || RANK[fact.classification] === undefined) continue;
    if (fact.classification === 'sensitive') sensitiveKeys.push(fact.key); else perKey[fact.key] = fact.classification;
  }
  if (sensitiveKeys.length) frontmatter.sensitive_keys = [...new Set(sensitiveKeys)];
  if (Object.keys(perKey).length) frontmatter.classifications = perKey;

  let notes = '';
  for (const fact of kept) {
    const value = JSON.parse(fact.value);
    if (fact.key === 'notes') { notes = typeof value === 'string' ? value : JSON.stringify(value); continue; }
    frontmatter[fact.key] = value;
  }
  if (entity.type === 'Commitment') {
    const attributes = JSON.parse(entity.attributes || '{}');
    if (attributes.status !== undefined) frontmatter.status = attributes.status;
    if (attributes.due !== undefined && frontmatter.due === undefined) frontmatter.due = attributes.due;
  }

  const text = `---\n${yaml.dump(frontmatter, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true })}---\n${notes ? `${notes}\n` : ''}`;
  try {
    fs.writeFileSync(path.join(vaultDir, relativePath), text, { flag: 'wx', mode: 0o600 });
    report.written.push(relativePath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    report.skippedExisting.push(relativePath);
  }
}

/** Records already described by a vault file (e.g. an export not yet indexed). */
function idsAlreadyInVault(vaultDir) {
  const ids = new Map();
  for (const dir of Object.keys(COLLECTIONS)) {
    for (const relativePath of listMarkdownFiles(vaultDir, dir)) {
      try {
        const id = readVaultFile(vaultDir, relativePath).frontmatter.id;
        if (typeof id === 'string') ids.set(id, relativePath);
      } catch { /* unreadable files are reported by the indexer */ }
    }
  }
  return ids;
}

/**
 * Moves delegated authority into the vault: the current home policy is
 * copied unchanged, so behaviour is identical and the vault file becomes
 * the one the owner edits. An existing vault policy is never replaced.
 */
function exportPolicies(vaultDir, report) {
  ensureDefaultPolicies();
  const header = '# What U2OS may do on your behalf (docs/policies.md).\n# Levels: always, autonomous (act without asking), confirm (ask first), never.\n# This file overrides U2OS_HOME/policies/policies.yaml per domain operation.\n\n';
  try {
    fs.writeFileSync(path.join(vaultDir, 'policies.yaml'), header + fs.readFileSync(policiesPath(), 'utf8'), { flag: 'wx', mode: 0o600 });
    report.written.push('policies.yaml');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    report.skippedExisting.push('policies.yaml');
  }
}

function uniquePath(vaultDir, dir, entity, taken) {
  const base = slug(entity.name) || entity.id;
  for (let n = 1; ; n++) {
    const candidate = path.posix.join(dir, `${base}${n === 1 ? '' : `-${n}`}.md`);
    if (!taken.has(candidate) && !fs.existsSync(path.join(vaultDir, candidate))) { taken.add(candidate); return candidate; }
  }
}

function slug(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
