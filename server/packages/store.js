// Persistent package state (docs/plugin-architecture.md §8): what is
// installed, what the owner granted, the owner's settings and provider
// selections, and the package audit view over agent_actions.
import { getDb } from '../db/connection.js';
import { validate as validateSchema } from './json-schema.js';
import { APPROVAL_MODES } from './policy.js';

const now = () => new Date().toISOString();

export function upsertPackage({ manifest, sourceType, sourceRef = null, installPath = null, enabled = true }) {
  const time = now();
  getDb().prepare(`INSERT INTO packages (id, version, name, description, source_type, source_ref, install_path, manifest, status, enabled, installed_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'installed', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, name = excluded.name, description = excluded.description,
      source_type = excluded.source_type, source_ref = excluded.source_ref, install_path = excluded.install_path,
      manifest = excluded.manifest, status = 'installed', enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(manifest.id, manifest.version, manifest.name, manifest.description || '', sourceType, sourceRef, installPath, JSON.stringify(manifest), enabled ? 1 : 0, time, time);
  return getPackageRow(manifest.id);
}

export function getPackageRow(id) {
  return rowToPackage(getDb().prepare('SELECT * FROM packages WHERE id = ?').get(id));
}

export function listPackageRows({ includeUninstalled = false } = {}) {
  const sql = includeUninstalled ? 'SELECT * FROM packages ORDER BY id' : "SELECT * FROM packages WHERE status = 'installed' ORDER BY id";
  return getDb().prepare(sql).all().map(rowToPackage);
}

export function setPackageEnabled(id, enabled) {
  getDb().prepare('UPDATE packages SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id);
  return getPackageRow(id);
}

export function markPackageUninstalled(id) {
  getDb().prepare("UPDATE packages SET status = 'uninstalled', enabled = 0, install_path = NULL, updated_at = ? WHERE id = ?").run(now(), id);
}

function rowToPackage(row) {
  if (!row) return null;
  return {
    id: row.id, version: row.version, name: row.name, description: row.description,
    sourceType: row.source_type, sourceRef: row.source_ref, installPath: row.install_path,
    manifest: JSON.parse(row.manifest), status: row.status, enabled: row.enabled === 1,
    installedAt: row.installed_at, updatedAt: row.updated_at,
  };
}

// --- grants ----------------------------------------------------------------

export function listGrants(packageId) {
  return getDb().prepare('SELECT permission FROM package_grants WHERE package_id = ? ORDER BY permission').all(packageId).map((row) => row.permission);
}

/** Grants only permissions the package declares; returns what was granted. */
export function grantPermissions(packageId, permissions, grantedBy = 'owner') {
  const row = getPackageRow(packageId);
  if (!row || row.status !== 'installed') throw notFound(`Package ${packageId} is not installed`);
  const declared = new Set(row.manifest.permissions);
  const undeclared = permissions.filter((permission) => !declared.has(permission));
  if (undeclared.length) {
    const error = new Error(`${packageId} does not declare: ${undeclared.join(', ')}`);
    error.status = 400;
    throw error;
  }
  const insert = getDb().prepare('INSERT OR IGNORE INTO package_grants (package_id, permission, granted_by, granted_at) VALUES (?,?,?,?)');
  const time = now();
  for (const permission of permissions) insert.run(packageId, permission, grantedBy, time);
  return listGrants(packageId);
}

export function revokePermissions(packageId, permissions = null) {
  if (permissions === null) getDb().prepare('DELETE FROM package_grants WHERE package_id = ?').run(packageId);
  else {
    const remove = getDb().prepare('DELETE FROM package_grants WHERE package_id = ? AND permission = ?');
    for (const permission of permissions) remove.run(packageId, permission);
  }
  return listGrants(packageId);
}

/** Drops grants for permissions a new package version no longer declares. */
export function pruneGrants(packageId, declared) {
  const keep = new Set(declared);
  const stale = listGrants(packageId).filter((permission) => !keep.has(permission));
  if (stale.length) revokePermissions(packageId, stale);
  return listGrants(packageId);
}

// --- settings ----------------------------------------------------------------

export function getStoredSettings(packageId) {
  const rows = getDb().prepare('SELECT kind, key, value FROM package_settings WHERE package_id = ?').all(packageId);
  const result = { settings: {}, policies: {} };
  for (const row of rows) (row.kind === 'policy' ? result.policies : result.settings)[row.key] = JSON.parse(row.value);
  return result;
}

/** Effective settings: manifest defaults overlaid with the owner's values. */
export function effectiveSettings(manifest, stored = getStoredSettings(manifest.id)) {
  const result = {};
  for (const [key, schema] of Object.entries(manifest.settings || {})) {
    if (Object.hasOwn(stored.settings, key)) result[key] = stored.settings[key];
    else if (schema.default !== undefined) result[key] = structuredClone(schema.default);
  }
  return result;
}

export function setSettings(manifest, values = {}) {
  const errors = [];
  for (const [key, value] of Object.entries(values)) {
    const schema = manifest.settings?.[key];
    if (!schema) errors.push(`${key}: unknown setting`);
    else if (value !== null) errors.push(...validateSchema(schema, value, key));
  }
  if (errors.length) { const error = new Error(`Invalid settings: ${errors.join('; ')}`); error.status = 400; throw error; }
  const time = now();
  for (const [key, value] of Object.entries(values)) {
    if (value === null) getDb().prepare("DELETE FROM package_settings WHERE package_id = ? AND kind = 'setting' AND key = ?").run(manifest.id, key);
    else getDb().prepare(`INSERT INTO package_settings (package_id, kind, key, value, updated_at) VALUES (?, 'setting', ?, ?, ?)
      ON CONFLICT(package_id, kind, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(manifest.id, key, JSON.stringify(value), time);
  }
  return effectiveSettings(manifest);
}

/** Owner override of a package policy's approval mode (null clears it). */
export function setPolicyApproval(manifest, policyName, approval) {
  if (!manifest.policies?.[policyName]) { const error = new Error(`Unknown policy ${policyName}`); error.status = 400; throw error; }
  if (approval === null) {
    getDb().prepare("DELETE FROM package_settings WHERE package_id = ? AND kind = 'policy' AND key = ?").run(manifest.id, policyName);
  } else {
    if (!APPROVAL_MODES.includes(approval)) { const error = new Error(`approval must be one of ${APPROVAL_MODES.join(', ')}`); error.status = 400; throw error; }
    getDb().prepare(`INSERT INTO package_settings (package_id, kind, key, value, updated_at) VALUES (?, 'policy', ?, ?, ?)
      ON CONFLICT(package_id, kind, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(manifest.id, policyName, JSON.stringify(approval), now());
  }
  return getStoredSettings(manifest.id).policies;
}

// --- provider selection --------------------------------------------------------

export function listProviderSelections() {
  return Object.fromEntries(getDb().prepare('SELECT capability_id, provider_id FROM capability_provider_selection').all().map((row) => [row.capability_id, row.provider_id]));
}

export function saveProviderSelection(capabilityId, providerId) {
  if (providerId === null) getDb().prepare('DELETE FROM capability_provider_selection WHERE capability_id = ?').run(capabilityId);
  else getDb().prepare(`INSERT INTO capability_provider_selection (capability_id, provider_id, updated_at) VALUES (?,?,?)
    ON CONFLICT(capability_id) DO UPDATE SET provider_id = excluded.provider_id, updated_at = excluded.updated_at`).run(capabilityId, providerId, now());
}

// --- audit -------------------------------------------------------------------

/**
 * Package actions from the one audit table (agent_actions). Arguments and
 * results are omitted here; the owner-only action detail view has them.
 */
export function listPackageAudit({ packageId = null, automationId = null, runId = null, limit = 100 } = {}) {
  const rows = getDb().prepare(`SELECT id, requested_by, tool, policy_rule, status, package_context, created_at, updated_at
    FROM agent_actions WHERE package_context IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 100, 1), 1000) * 4);
  return rows.map((row) => ({
    id: row.id, requestedBy: row.requested_by, action: row.tool, rule: row.policy_rule, status: row.status,
    context: JSON.parse(row.package_context), createdAt: row.created_at, updatedAt: row.updated_at,
  })).filter((entry) => (!packageId || entry.context.package === packageId)
    && (!automationId || entry.context.automation === automationId)
    && (!runId || entry.context.run === runId)).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 1000));
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
