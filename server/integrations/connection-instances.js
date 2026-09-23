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
import { CONNECTOR_CATALOG, providerIdsForConnector } from './connector-catalog.js';
import { log } from '../logging/logger.js';

// -----------------------------------------------------------------------
// issue #163 PR 2 of 5: connection_instances CRUD, layered on top of PR 1's
// table + migration above. server/api/routes/connectors.js's new
// /api/connectors/:connectorId/instances routes call the exported functions
// below rather than issuing raw SQL themselves, so every read/write of this
// table stays in one place. Per-connector credential shape
// validation/normalization stays in the routes file (it's an HTTP-boundary
// concern, same pattern as trigger config validation in
// server/api/routes/triggers.js) -- this module only knows how to store an
// already-validated plaintext object against a vault_key and keep the row
// in sync with it.
// -----------------------------------------------------------------------

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
 * through an explicit IMAP association, not an active SMTP domain. */
function matchingDomains(connectorId, config) {
  const providerIds = providerIdsForConnector(connectorId);
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

  // OAuth client credentials are shared by all Google account instances.
  // Earlier migrations moved the combined legacy file (including client
  // credentials) into the first instance and removed the bare file. Restore
  // a client-only shared file on every boot when needed, after the instance
  // copy has been verified. Never recreate it from a deleted account.
  const migratedGoogle = db.prepare("SELECT * FROM connection_instances WHERE connector_id = 'google' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get();
  if (migratedGoogle) {
    try {
      const shared = readEncryptedFile('google', dataDir) || {};
      const account = readEncryptedFile(migratedGoogle.vault_key, dataDir) || {};
      const clientId = shared.clientId || account.clientId;
      const clientSecret = shared.clientSecret || account.clientSecret;
      if (clientId && clientSecret && (shared.clientId !== clientId || shared.clientSecret !== clientSecret || shared.tokens)) {
        writeEncryptedFile('google', { clientId, clientSecret }, dataDir);
      }
    } catch (err) {
      log.warn('connection-instances', 'could not restore shared Google OAuth client configuration', { error: err?.message || String(err) });
    }
  }
  // Only the two unambiguous migrated legacy accounts are paired. Never
  // infer a sender for newly created accounts or overwrite an owner choice.
  const migratedImap = db.prepare("SELECT * FROM connection_instances WHERE connector_id = 'imap' AND deleted_at IS NULL AND metadata LIKE '%legacy-single-file%' ORDER BY created_at LIMIT 1").get();
  const migratedSmtp = db.prepare("SELECT * FROM connection_instances WHERE connector_id = 'smtp' AND deleted_at IS NULL AND metadata LIKE '%legacy-single-file%' ORDER BY created_at LIMIT 1").get();
  // Releases between the first instance migration and account pairing
  // restored the bare SMTP file for the old UI. It may contain newer
  // settings, or {} after Disconnect. Reconcile it into the migrated row,
  // verify the encrypted copy, then remove the obsolete file. A failed
  // write/verification leaves the bare file untouched for a safe retry.
  if (migratedSmtp) {
    try {
      const legacy = readEncryptedFile('smtp', dataDir);
      if (legacy !== null) {
        const current = readEncryptedFile(migratedSmtp.vault_key, dataDir);
        if (JSON.stringify(legacy) !== JSON.stringify(current)) {
          writeEncryptedFile(migratedSmtp.vault_key, legacy, dataDir);
          if (JSON.stringify(readEncryptedFile(migratedSmtp.vault_key, dataDir)) !== JSON.stringify(legacy)) {
            throw new Error('SMTP credential copy verification failed');
          }
          db.prepare('UPDATE connection_instances SET status = ?, credential_revision = credential_revision + 1, updated_at = ? WHERE id = ?')
            .run(looksConnected('smtp', legacy) ? 'connected' : 'pending', new Date().toISOString(), migratedSmtp.id);
        }
        deleteLegacyFileBestEffort('smtp', 'smtp', dataDir);
      }
    } catch (err) {
      log.warn('connection-instances', 'could not reconcile legacy SMTP transport settings; original file retained', { error: err?.message || String(err) });
    }
  }
  if (migratedImap && migratedSmtp && !migratedImap.smtp_pair_initialized) {
    db.prepare('UPDATE connection_instances SET smtp_instance_id = ?, smtp_pair_initialized = 1, updated_at = ? WHERE id = ? AND smtp_pair_initialized = 0')
      .run(migratedSmtp.id, new Date().toISOString(), migratedImap.id);
  }

  return results;
}

// -----------------------------------------------------------------------
// CRUD (issue #163 PR 2 of 5)
// -----------------------------------------------------------------------

/** Maps a connection_instances DB row to the API-facing, GUARANTEED
 * secret-free shape: only columns that can never hold a credential are
 * ever read here (never `vault_key`, never `metadata`, and nothing that
 * requires a vault read). Every route below builds its response through
 * this function (or a plain array of it) so a secret leaking into an API
 * response would require a code path that bypasses this entirely, not just
 * a missed field. */
function toInstanceApiShape(db, row) {
  const sync = Object.fromEntries(db.prepare('SELECT domain, last_sync_at, last_error FROM connection_sync_state WHERE instance_id = ?').all(row.id)
    .map((entry) => [entry.domain, { lastSyncAt: entry.last_sync_at, lastError: entry.last_error }]));
  return {
    id: row.id,
    connectorId: row.connector_id,
    label: row.label,
    status: row.status,
    lastError: row.last_error,
    lastSyncAt: row.last_sync_at,
    sync,
    smtpInstanceId: row.connector_id === 'imap' ? row.smtp_instance_id : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Lists every non-deleted instance for a connector id, oldest first. Pure
 * `connection_instances` read -- never touches the vault, so it is
 * structurally impossible for this function to leak a decrypted secret. */
export function listInstances(db, connectorId) {
  const rows = db
    .prepare('SELECT * FROM connection_instances WHERE connector_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all(connectorId);
  return rows.map((row) => toInstanceApiShape(db, row));
}

/** Internal-only counterpart to listInstances(): returns RAW (secret-key-
 * bearing) rows -- includes vault_key and metadata -- for connector-internal
 * callers that need them. Added for issue #163 PR 4's provider-registry.js,
 * which needs a connector's live instance rows to resolve a domain's
 * connected instance (including the "exactly one connected instance"
 * fallback when a domain has no explicit activeInstanceId yet) and to check
 * server/integrations/connector-instance-ids.js's grandfathered/
 * non-grandfathered id-prefix rule. NEVER call this from an HTTP route
 * handler -- toInstanceApiShape() (used by listInstances() above) is what
 * keeps a vault_key out of every API response, and this function
 * deliberately bypasses it. */
export function listInstanceRows(db, connectorId) {
  return db
    .prepare('SELECT * FROM connection_instances WHERE connector_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all(connectorId);
}

/** Finds the raw (non-API-shaped) DB row for a single instance, scoped to
 * both instanceId AND connectorId AND "not soft-deleted" in one query --
 * this is what makes a mismatched {connectorId, instanceId} pair (or a
 * soft-deleted instance) resolve to "not found" rather than accidentally
 * operating on the wrong connector's instance. Returns null, never throws,
 * so callers (route handlers) turn a null into their own 404/400. */
export function findInstance(db, connectorId, instanceId) {
  return (
    db
      .prepare('SELECT * FROM connection_instances WHERE id = ? AND connector_id = ? AND deleted_at IS NULL')
      .get(instanceId, connectorId) || null
  );
}

export function associateSmtpInstance(db, { imapRow, smtpInstanceId }) {
  if (imapRow?.connector_id !== 'imap') throw new Error('IMAP account is required');
  if (smtpInstanceId !== null && !findInstance(db, 'smtp', smtpInstanceId)) throw new Error('SMTP account is unavailable');
  const now = new Date().toISOString();
  db.prepare('UPDATE connection_instances SET smtp_instance_id = ?, smtp_pair_initialized = 1, credential_revision = credential_revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(smtpInstanceId, now, imapRow.id);
  return toInstanceApiShape(db, findInstance(db, 'imap', imapRow.id));
}

/** Creates a new connection instance: mints an id + vault_key
 * ('<connectorId>__<instanceId>', matching PR 1's migration convention),
 * writes `credentials` to the vault only if non-null (google instances are
 * created credential-less -- OAuth attaches tokens to this vault_key
 * later, in PR 3), inserts the row, and returns its secret-free API shape.
 * `credentials` must already be validated/normalized by the caller -- this
 * function does no per-connector-type validation itself. */
export function createConnectionInstance(db, { connectorId, label, credentials = null, status = 'pending', dataDir } = {}) {
  const id = newId('conn');
  const vaultKey = `${connectorId}__${id}`;
  if (credentials != null) {
    writeEncryptedFile(vaultKey, credentials, dataDir);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connection_instances (id, connector_id, label, status, vault_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, connectorId, label, status, vaultKey, now, now);
  return toInstanceApiShape(db, db.prepare('SELECT * FROM connection_instances WHERE id = ?').get(id));
}

/** Updates an existing instance's label and/or stored credentials.
 * `row` must be a live row previously returned by findInstance (the caller
 * already did the connectorId/instanceId/not-deleted check). `label`
 * undefined leaves the label unchanged; `credentials` undefined leaves the
 * vault entry untouched, while any other value (already
 * validated/merged/normalized by the caller) overwrites it entirely via
 * the row's existing vault_key -- callers that want a partial credential
 * update must read-merge-validate themselves before calling this. */
export function updateConnectionInstance(db, { row, label, credentials, dataDir } = {}) {
  if (credentials !== undefined) {
    writeEncryptedFile(row.vault_key, credentials, dataDir);
  }
  const nextLabel = label !== undefined ? label : row.label;
  const now = new Date().toISOString();
  db.prepare('UPDATE connection_instances SET label = ?, credential_revision = credential_revision + ?, updated_at = ? WHERE id = ?')
    .run(nextLabel, credentials !== undefined ? 1 : 0, now, row.id);
  return toInstanceApiShape(db, db.prepare('SELECT * FROM connection_instances WHERE id = ?').get(row.id));
}

/** Soft-deletes an instance (sets deleted_at) and removes its vault file.
 * `row` must be a live row previously returned by findInstance. Returns the
 * deleted instance's final secret-free API shape (deletion does not change
 * any of the fields toInstanceApiShape reads, so the returned `status` is
 * whatever it was immediately before deletion -- callers that need to
 * signal "this is now deleted" add that themselves in the response). Does
 * NOT touch connectors.yaml -- resetting a domain's active/activeInstanceId
 * when the deleted instance was the active one is the route handler's job
 * (it also needs to trigger a sync-scheduler reconcile), not this module's. */
export function deleteConnectionInstance(db, { row, dataDir } = {}) {
  // Vault deletion happens BEFORE the DB soft-delete, deliberately.
  // deleteEncryptedFile() is idempotent (a no-op if the file is already
  // gone), so if it throws (I/O error, permissions), the row is left live
  // and findInstance()/listInstances() still return it -- the DELETE can
  // simply be retried. Doing this in the opposite order would let a
  // vault-delete failure soft-delete the row first, permanently orphaning a
  // decryptable secret file: findInstance()/listInstances() both filter
  // deleted_at IS NULL, so a deleted-but-not-vault-cleaned row can never be
  // looked up again via the API -- an unrecoverable secret leak with no DB
  // pointer and no cleanup path.
  deleteEncryptedFile(row.vault_key, dataDir);
  const now = new Date().toISOString();
  db.prepare('UPDATE connection_instances SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
  return toInstanceApiShape(db, { ...row, updated_at: now });
}
