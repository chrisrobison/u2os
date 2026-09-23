// Migration: one-time (idempotent, safe to re-run on every boot) promotion
// of legacy single-account *.enc.json credential files into the new
// connection_instances table (issue #163, PR 1 of 5 -- schema + migration
// only; no API routes, OAuth, or provider routing changes here, see
// docs/connectors.md and server/db/schema.sql's connection_instances
// comment). connector-catalog.js already models most connectors as
// `accountMode: 'multiple'`; this module is the bridge that carries forward
// whatever an existing installation already had configured under the old
// "one set of credentials per connector" model, losslessly, so nothing an
// owner previously connected silently disappears when this ships.
//
// SECURITY: never log a decrypted credential/token/value anywhere -- same
// rule as server/security/vault.js. Only connector ids, instance ids,
// booleans, and error messages (which the provider/vault layers already
// keep secret-free) are ever logged below.
import { newId } from '../db/ids.js';
import { readEncryptedFile, writeEncryptedFile, deleteEncryptedFile } from '../security/vault.js';
import { loadConnectorsConfig, saveConnectorsConfig } from './connectors-config.js';
import { CONNECTOR_CATALOG } from './connector-catalog.js';
import { log } from '../logging/logger.js';

// connectorId is the STABLE identity carried forward (matches
// connector-catalog.js's `id` field, and REAL_PROVIDERS'/connectors.yaml's
// provider id wherever one already exists) -- deliberately NOT always the
// same as the legacy vault filename, which predates the catalog:
//  - 'brave-search': catalog id, REAL_PROVIDERS key, and connectors.yaml's
//    web-domain provider id are all "brave-search", but the one vault file
//    it has ever written to is web-search.enc.json (see
//    server/integrations/brave-search-provider.js and
//    server/api/routes/connectors.js's /api/connectors/web-search/credentials
//    route).
//  - 'webhook': catalog id, REAL_PROVIDERS key, and connectors.yaml's
//    notifications-domain provider id are all "webhook", but its vault file
//    is notify-webhook.enc.json (see
//    server/integrations/webhook-notify-provider.js).
// google/imap/smtp's catalog id and legacy vault filename already coincide.
const LEGACY_CONNECTORS = [
  { connectorId: 'google', vaultFileId: 'google' },
  { connectorId: 'imap', vaultFileId: 'imap' },
  { connectorId: 'smtp', vaultFileId: 'smtp' },
  { connectorId: 'brave-search', vaultFileId: 'web-search' },
  { connectorId: 'webhook', vaultFileId: 'notify-webhook' },
];

const MIGRATION_TAG = 'legacy-single-file';

function catalogEntry(connectorId) {
  return CONNECTOR_CATALOG.find((c) => c.id === connectorId) || null;
}

function isEmptyPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** A best-effort, non-throwing "does this look like a working credential?"
 * heuristic per connector type -- used only to pick the migrated row's
 * initial status ('connected' vs 'pending'), never to validate/reject
 * anything. Deliberately duplicated (rather than importing each
 * *-provider.js's validateSettings, which throws on missing fields) so a
 * partially-filled legacy file -- e.g. Google OAuth client id/secret saved
 * but never completed -- still produces a row instead of being skipped. */
function looksConnected(connectorId, plaintext) {
  switch (connectorId) {
    case 'google': {
      const tokens = plaintext?.tokens || {};
      return Object.values(tokens).some((t) => t && typeof t === 'object' && Boolean(t.refresh_token));
    }
    case 'imap':
    case 'smtp': {
      const { host, username, password } = plaintext || {};
      return Boolean(host) && Boolean(username) && Boolean(password);
    }
    case 'brave-search':
      return Boolean(plaintext?.apiKey);
    case 'webhook':
      return Boolean(plaintext?.webhookUrl);
    default:
      return false;
  }
}

/** Deterministic, always-non-empty label for a migrated instance (no user
 * input is available during migration). imap/smtp prefer "<user>@<host>"
 * when both fields are present and non-empty; every other case, or a
 * missing field, falls back to "<catalog display name> (migrated)". */
function buildLabel(connectorId, plaintext) {
  const catalog = catalogEntry(connectorId);
  const displayName = catalog?.name || connectorId;
  if (connectorId === 'imap' || connectorId === 'smtp') {
    const username = plaintext?.username || plaintext?.user;
    const host = plaintext?.host;
    if (typeof username === 'string' && username.trim() && typeof host === 'string' && host.trim()) {
      return `${username.trim()}@${host.trim()}`;
    }
  }
  return `${displayName} (migrated)`;
}

function alreadyMigrated(db, connectorId) {
  // Deliberately NOT filtered on deleted_at IS NULL: a connector that was
  // migrated and then later soft-deleted (owner disconnected it) must still
  // read as "already migrated" forever after -- otherwise, if the legacy
  // file's best-effort post-migration delete previously failed and left an
  // orphaned legacy file behind, the next boot would see zero *live* rows,
  // conclude the connector was never migrated, and silently resurrect the
  // credentials the owner explicitly removed by re-migrating that orphan.
  const rows = db.prepare('SELECT metadata FROM connection_instances WHERE connector_id = ?').all(connectorId);
  return rows.some((row) => {
    try {
      return JSON.parse(row.metadata || '{}')?.migratedFrom === MIGRATION_TAG;
    } catch {
      return false;
    }
  });
}

/** Which connectors.yaml domains this connector id is currently the active
 * provider for, so the migrated instance can be recorded as that domain's
 * activeInstanceId. For most connectors here catalog id === yaml provider
 * id (imap, brave-search, webhook). google is multi-service -- its catalog
 * setup.services entries carry the real per-domain provider ids
 * (google-calendar/gmail/google-contacts) -- so those are matched too,
 * rather than the literal (and for google, never-matching) "active ===
 * connectorId". smtp intentionally matches no domain: email.send goes
 * through smtp-transport.js directly and is never gated by the email
 * domain's active *read* provider in connectors.yaml, so it has nothing to
 * point activeInstanceId at here. */
function matchingDomains(connectorId, config) {
  const catalog = catalogEntry(connectorId);
  const providerIds = new Set([connectorId]);
  for (const service of catalog?.setup?.services || []) {
    if (service.providerId) providerIds.add(service.providerId);
  }
  return Object.keys(config).filter((domain) => providerIds.has(config[domain]?.active));
}

function deleteLegacyFileBestEffort(connectorId, vaultFileId, dataDir) {
  // Row is durably committed by this point -- only now is it safe to delete
  // the legacy file. Best-effort: if this throws, the legacy file is simply
  // left behind forever as a harmless orphan (the row already exists, so
  // the next boot's alreadyMigrated() check skips re-migrating this
  // connector) -- never a data-loss risk, since the row + its new vault_key
  // already hold the durable, verified copy.
  try {
    deleteEncryptedFile(vaultFileId, dataDir);
  } catch (err) {
    log.warn(
      'connection-instances',
      `migrated "${connectorId}" but could not delete its legacy credential file -- harmless leftover, will not be retried`,
      { connectorId, error: err?.message || String(err) }
    );
  }
}

/**
 * Migrates every legacy single-account credential file into a
 * connection_instances row, once, idempotently. Safe to call on every
 * server boot (server/index.js does, right after
 * ensureDefaultConnectorsConfig()): a connector already migrated (a
 * non-deleted connection_instances row with
 * metadata.migratedFrom === 'legacy-single-file') is skipped outright, and
 * a connector with no legacy file, or one that decrypts to an empty object
 * (nothing ever actually saved), produces no row.
 *
 * Returns an array of per-connector results (never throws for an individual
 * connector's failure -- each is caught and logged so one bad legacy file
 * can never block startup or the other four connectors' migrations).
 */
export function ensureConnectionInstancesMigrated({ db, dataDir } = {}) {
  if (!db) throw new Error('ensureConnectionInstancesMigrated: db is required');

  const config = loadConnectorsConfig(dataDir);
  const results = [];

  for (const { connectorId, vaultFileId } of LEGACY_CONNECTORS) {
    if (alreadyMigrated(db, connectorId)) {
      results.push({ connectorId, migrated: false, reason: 'already-migrated' });
      continue;
    }

    let plaintext;
    try {
      plaintext = readEncryptedFile(vaultFileId, dataDir);
    } catch (err) {
      // Exists but fails to decrypt (rotated/corrupted master key, tampered
      // file) -- never crash boot over this, and never touch the file.
      log.warn(
        'connection-instances',
        `legacy credential file for "${connectorId}" could not be read -- skipping migration for this connector`,
        { connectorId, error: err?.message || String(err) }
      );
      results.push({ connectorId, migrated: false, reason: 'unreadable' });
      continue;
    }

    if (plaintext == null || isEmptyPlainObject(plaintext)) {
      results.push({ connectorId, migrated: false, reason: 'not-configured' });
      continue;
    }

    const instanceId = newId('conn');
    const vaultKey = `${connectorId}__${instanceId}`;
    writeEncryptedFile(vaultKey, plaintext, dataDir);

    // Verify the round-trip byte-for-byte (deep JSON equality) BEFORE doing
    // anything destructive (inserting the row, deleting the legacy file).
    let verified;
    try {
      verified = readEncryptedFile(vaultKey, dataDir);
    } catch (err) {
      log.error(
        'connection-instances',
        `post-write verification read failed for "${connectorId}" -- aborting migration for this connector, legacy file left untouched`,
        { connectorId, error: err?.message || String(err) }
      );
      results.push({ connectorId, migrated: false, reason: 'verify-failed' });
      continue;
    }
    if (JSON.stringify(verified) !== JSON.stringify(plaintext)) {
      log.error(
        'connection-instances',
        `post-write verification mismatch for "${connectorId}" -- aborting migration for this connector, legacy file left untouched`,
        { connectorId }
      );
      results.push({ connectorId, migrated: false, reason: 'verify-mismatch' });
      continue;
    }

    const now = new Date().toISOString();
    const status = looksConnected(connectorId, plaintext) ? 'connected' : 'pending';
    const label = buildLabel(connectorId, plaintext);
    const metadata = JSON.stringify({ migratedFrom: MIGRATION_TAG });

    try {
      db.prepare(
        `INSERT INTO connection_instances (id, connector_id, label, status, vault_key, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(instanceId, connectorId, label, status, vaultKey, metadata, now, now);
    } catch (err) {
      // Insert failed -- the new vault_key's plaintext copy is orphaned
      // (harmless: nothing durable references it yet) but the legacy file
      // MUST NOT be deleted, since nothing durable now points at the
      // migrated copy. The next boot retries from scratch (alreadyMigrated()
      // correctly reports false; a fresh instanceId/vaultKey is generated).
      log.error(
        'connection-instances',
        `failed to insert connection_instances row for "${connectorId}" -- legacy file left untouched`,
        { connectorId, error: err?.message || String(err) }
      );
      results.push({ connectorId, migrated: false, reason: 'insert-failed' });
      continue;
    }

    deleteLegacyFileBestEffort(connectorId, vaultFileId, dataDir);

    // Persisted immediately, per-connector, rather than batched after the
    // loop: the row + vault_key are already durably committed at this point,
    // so a crash between here and the end of the loop must not be able to
    // lose the activeInstanceId linkage for this (or any earlier) connector
    // with no retry path -- alreadyMigrated() will (correctly) never revisit
    // an already-inserted row, so a batched trailing save would have been
    // the only place this linkage was ever written.
    const domains = matchingDomains(connectorId, config);
    if (domains.length) {
      for (const domain of domains) {
        config[domain] = { ...config[domain], activeInstanceId: instanceId };
      }
      saveConnectorsConfig(config, dataDir);
    }

    log.info('connection-instances', `migrated legacy "${connectorId}" credentials into a connection instance`, {
      connectorId,
      instanceId,
      status,
      domains,
    });
    results.push({ connectorId, migrated: true, instanceId, status, domains });
  }

  return results;
}
