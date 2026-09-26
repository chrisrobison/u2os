// Resolves, per domain, either a connected real provider or (only in an
// explicit demo home) a mock provider. Personal mode never substitutes mock
// results for an unconfigured or disconnected real connector. Per docs/connectors.md's
// "server/integrations/provider-registry.js" section.
//
// The registry statically imports every provider module up front (the set
// is fixed for this phase -- no dynamic plugin loading yet) and re-reads
// connectors-config on every getProvider() call, so flipping the active
// provider in connectors.yaml (or via the API) takes effect on the very next
// call, with no server restart required.
//
// Instance-aware (issue #163 PR 4 of 5): a domain's `active` provider id is
// no longer enough on its own -- since a connector can now have MULTIPLE
// connected accounts (server/integrations/connection-instances.js), the
// registry must also resolve WHICH connection instance backs that domain
// (`config[domain].activeInstanceId`) and thread that instance's vault key
// through to the real provider module. See bindProviderToInstance() below
// for how a resolved instance is made available to every provider call
// without changing any existing call site's zero-options call shape.
import * as mockCalendar from './mock-calendar-provider.js';
import * as mockEmail from './mock-email-provider.js';
import * as mockContacts from './mock-contacts-provider.js';
import * as mockWeb from './mock-web-search-provider.js';
import * as mockNotifications from './mock-notifications-provider.js';
import * as googleCalendar from './google-calendar-provider.js';
import { googleReadFailureMetadata } from './google-read-deadline.js';
import * as gmail from './gmail-provider.js';
import * as imap from './imap-provider.js';
import * as googleContacts from './google-contacts-provider.js';
import * as braveSearch from './brave-search-provider.js';
import * as webhookNotify from './webhook-notify-provider.js';
import { loadConnectorsConfig, validProviderIdsFor, DOMAINS } from './connectors-config.js';
import { connectorIdForProviderId } from './connector-catalog.js';
import { findInstance, listInstanceRows } from './connection-instances.js';
import { getDb } from '../db/connection.js';
import { log } from '../logging/logger.js';
import { readInstallationMode } from '../seed/installation-mode.js';

const MOCK_PROVIDERS = {
  calendar: mockCalendar,
  email: mockEmail,
  contacts: mockContacts,
  web: mockWeb,
  notifications: mockNotifications,
};

// providerId -> module, for every REAL connector this phase implements.
// Ids named in connectors-config's VALID_PROVIDER_IDS but absent here
// (caldav) simply have no module -- resolved as unavailable.
const REAL_PROVIDERS = {
  'google-calendar': googleCalendar,
  gmail,
  imap,
  'google-contacts': googleContacts,
  'brave-search': braveSearch,
  webhook: webhookNotify,
};

// Which of each real provider module's exported functions take a
// connection instance -- every one of them touches the vault and/or (for
// the 3 Google modules) generates a local row id from an upstream id, per
// connector-instance-ids.js. Deliberately explicit (rather than binding
// every exported function blindly) so a plain-data argument that happens to
// be an object (e.g. gmail.sendEmail's `{to, subject, body}`) never gets
// mistaken for a trailing options object -- see withInjectedOptions() below.
//
// IMAP sendEmail receives the selected inbox instance here; its approved
// SMTP identity is passed separately by the consequential tool.
// Each method name maps to its ARITY: how many positional "data" arguments
// it takes BEFORE the trailing options object (0 for a method like
// syncChanges({db, eventBus, ...}) whose single argument already IS the
// options object). This is required, not merely convenient: every one of
// these methods is called by its tool/trigger-engine/adapter call site with
// ONLY the data argument(s) and no options object at all (e.g.
// `provider.send(args)`, `provider.search(args)`) -- so a "is the last
// argument options-shaped?" heuristic cannot tell a 1-arity method's sole
// (data) argument apart from a 0-arity method's sole (options) argument,
// since both are plain objects and both are `args[0]`. Knowing the arity up
// front lets withInjectedOptions() always inject at the correct fixed
// position instead of guessing.
const OPTIONS_ARITY = {
  'google-calendar': { listEvents: 1, getEvent: 1, createEvent: 1, rescheduleEvent: 2, syncChanges: 0 },
  gmail: { listEmails: 1, getEmail: 1, sendEmail: 1, syncChanges: 0 },
  'google-contacts': { searchContacts: 1, syncChanges: 0 },
  imap: { syncChanges: 0, listEmails: 1, getEmail: 1, sendEmail: 1 },
  'brave-search': { search: 1 },
  webhook: { send: 1 },
};

// Logs a health warning once per (domain, providerId) pair per process,
// rather than spamming on every call.
const warnedOnce = new Set();

/** Whether `instance` (a raw connection_instances row) is actually
 * connected for `providerId`'s specific service -- e.g. a 'google' instance
 * may have calendar tokens but no gmail tokens, so this is per-providerId,
 * not per-connector. Every real provider module's isConnected(vaultKey,
 * dataDir) takes an explicit vault key (no default), matching
 * oauth/google-oauth.js's existing convention -- see that file's header. */
export function isProviderInstanceConnected(providerId, instance, dataDir) {
  const real = REAL_PROVIDERS[providerId];
  // Retained credentials are evidence, not permission to enable an account.
  // Fail closed for unknown future statuses as well as pending/disconnected.
  if (!real || typeof real.isConnected !== 'function' || !instance || instance.deleted_at || instance.status !== 'connected') return false;
  try {
    return !!real.isConnected(instance.vault_key, dataDir);
  } catch {
    return false;
  }
}

/** Resolves the raw connection_instances row backing a domain's active
 * provider id. If the domain has an explicit `activeInstanceId` (set by the
 * PR 2 CRUD API's /active route, or by the migration), that instance is
 * used exactly as configured -- findInstance() returns null for a missing
 * or soft-deleted instance, which callers correctly treat as "not
 * connected" rather than falling back to guessing. If there's no explicit
 * activeInstanceId (a hand-edited connectors.yaml, or the legacy
 * bare-providerId path such as activateGoogleProvider() after a completed
 * OAuth flow), this falls back to the connector's sole instance that is
 * ACTUALLY connected for this specific providerId -- but only if there is
 * exactly one. It never silently guesses between multiple connected
 * candidates of the same connector. */
export function resolveInstanceForDomain(providerId, activeInstanceId, dataDir) {
  const connectorId = connectorIdForProviderId(providerId);
  if (!connectorId) return null;
  const db = getDb();
  if (activeInstanceId) {
    return findInstance(db, connectorId, activeInstanceId);
  }
  const candidates = listInstanceRows(db, connectorId).filter((row) => isProviderInstanceConnected(providerId, row, dataDir));
  return candidates.length === 1 ? candidates[0] : null;
}

function withInjectedOptions(fn, extra, arity) {
  return (...args) => {
    if (args.length > arity) {
      const existing = args[arity];
      const hasOptions = existing !== undefined && existing !== null && typeof existing === 'object' && !Array.isArray(existing);
      args[arity] = hasOptions ? { ...existing, ...extra } : extra;
    } else {
      while (args.length < arity) args.push(undefined);
      args[arity] = extra;
    }
    return fn(...args);
  };
}

/** Wraps a real provider module's instance-bound methods (per
 * OPTIONS_ARITY above) so every existing call site elsewhere in the
 * codebase (server/tools/*.js, trigger-engine.js, the notification service
 * adapter) keeps working with its current zero-options call shape -- e.g.
 * `provider.listEvents(args)` -- while the resolved connection instance and
 * dataDir are injected into each call's options object automatically, at
 * the fixed position OPTIONS_ARITY says that method's options object
 * belongs at. Non-bound properties (the `id` string, `isConnected`,
 * `validateSettings`, etc.) pass through unchanged. */
function bindProviderToInstance(providerId, real, instance, dataDir) {
  const bound = { ...real, connectionInstanceId: instance.id };
  for (const [name, arity] of Object.entries(OPTIONS_ARITY[providerId] || {})) {
    if (typeof real[name] === 'function') {
      bound[name] = withInjectedOptions(real[name].bind(real), { dataDir, instance }, arity);
    }
  }
  return bound;
}

function warnNotConnectedOnce(domain, activeId, dataDir) {
  const warnKey = `${domain}:${activeId}`;
  if (warnedOnce.has(warnKey)) return;
  warnedOnce.add(warnKey);
  log.warn(
    'provider-registry',
    `domain "${domain}" is configured for "${activeId}" but that connector is not connected yet${readInstallationMode(dataDir) === 'demo' ? ' -- using demo mock' : ''}.`,
    { domain, activeId }
  );
}

/**
 * getProvider(domain) -> the resolved provider module for that domain.
 * Domains: calendar, email, contacts, web, notifications. For a connected
 * real provider, the returned object is bound to the domain's resolved
 * connection instance (see bindProviderToInstance) -- callers never need to
 * know or pass which instance is active.
 */
export function getProvider(domain, { dataDir } = {}) {
  const mockProvider = MOCK_PROVIDERS[domain];
  if (!mockProvider) throw new Error(`provider-registry: unknown domain "${domain}"`);

  const config = loadConnectorsConfig(dataDir);
  const activeId = config[domain]?.active || 'mock';
  const demo = readInstallationMode(dataDir) === 'demo';

  if (activeId === 'mock') {
    if (!demo) throw unavailable(domain, 'No real service is selected');
    return mockProvider;
  }

  const real = REAL_PROVIDERS[activeId];
  if (!real) throw unavailable(domain, `${activeId} is not implemented`);

  const instance = resolveInstanceForDomain(activeId, config[domain]?.activeInstanceId, dataDir);
  if (!instance || !isProviderInstanceConnected(activeId, instance, dataDir)) {
    warnNotConnectedOnce(domain, activeId, dataDir);
    if (!demo) throw unavailable(domain, `${activeId} is disconnected`);
    return mockProvider;
  }
  return bindProviderToInstance(activeId, real, instance, dataDir);
}

/** Capture the runtime-selected identity before a consequential action is
 * audited. The model never supplies any of these fields. */
export function captureAccountBinding(domain, { dataDir } = {}) {
  const config = loadConnectorsConfig(dataDir);
  const providerId = config[domain]?.active || 'mock';
  if (providerId === 'mock') {
    if (readInstallationMode(dataDir) !== 'demo') throw unavailable(domain, 'No real service is selected');
    return { domain, providerId, connectorId: null, instanceId: null, label: 'Mock' };
  }
  const connectorId = connectorIdForProviderId(providerId);
  const instance = resolveInstanceForDomain(providerId, config[domain]?.activeInstanceId, dataDir);
  if (!connectorId || !isProviderInstanceConnected(providerId, instance, dataDir)) {
    throw new Error(`No connected account is selected for ${domain}; connect or select an account before proposing this action`);
  }
  return { domain, providerId, connectorId, instanceId: instance.id, credentialRevision: instance.credential_revision, label: instance.label };
}

/** Resolve only the persisted identity. Switching the active provider cannot
 * redirect an approved or queued action. Deleted/disconnected accounts fail
 * before any provider call. */
export function getProviderForBinding(domain, binding, { dataDir } = {}) {
  if (!binding || binding.domain !== domain) throw new Error(`Account binding is missing for ${domain}; owner review required`);
  if (binding.providerId === 'mock' && binding.instanceId === null && binding.connectorId === null) {
    if (readInstallationMode(dataDir) !== 'demo') throw unavailable(domain, 'Demo account binding is unavailable in personal mode');
    return MOCK_PROVIDERS[domain];
  }
  if (!validProviderIdsFor(domain).includes(binding.providerId) || connectorIdForProviderId(binding.providerId) !== binding.connectorId) {
    throw new Error(`Account binding is invalid for ${domain}; owner review required`);
  }
  const instance = findInstance(getDb(), binding.connectorId, binding.instanceId);
  if (instance && instance.credential_revision !== binding.credentialRevision) {
    throw new Error(`Selected account for ${domain} was reconnected or changed; new approval is required`);
  }
  if (!isProviderInstanceConnected(binding.providerId, instance, dataDir)) {
    throw new Error(`Selected account for ${domain} is deleted or disconnected; no action was attempted`);
  }
  return bindProviderToInstance(binding.providerId, REAL_PROVIDERS[binding.providerId], instance, dataDir);
}

/** Returns the real provider module for `domain` ONLY if it's the
 * configured active provider AND currently connected (via its resolved
 * connection instance), else null. Used by sync-scheduler.js, which must
 * never poll a mock or a not-yet-connected real provider. */
export function resolveConnectedRealProvider(domain, { dataDir } = {}) {
  const config = loadConnectorsConfig(dataDir);
  const activeId = config[domain]?.active || 'mock';
  if (activeId === 'mock') return null;
  const real = REAL_PROVIDERS[activeId];
  if (!real) return null;
  const instance = resolveInstanceForDomain(activeId, config[domain]?.activeInstanceId, dataDir);
  if (!instance || !isProviderInstanceConnected(activeId, instance, dataDir)) return null;
  return bindProviderToInstance(activeId, real, instance, dataDir);
}

/** Whether ANY live instance of the connector backing `providerId` is
 * currently connected -- used only by getHealth()'s connectedProviders list
 * (which providers the UI can offer to switch a domain to), independent of
 * which instance (if any) is the domain's current active one. */
function isAnyInstanceConnected(providerId, dataDir) {
  const connectorId = connectorIdForProviderId(providerId);
  if (!connectorId) return false;
  const db = getDb();
  return listInstanceRows(db, connectorId).some((row) => isProviderInstanceConnected(providerId, row, dataDir));
}

/** GET /api/connectors' primary data source: per-domain status plus which
 * provider ids exist for that domain (for the UI to render toggles). Never
 * includes decrypted secrets -- only booleans and non-secret metadata. */
export function getHealth({ dataDir } = {}) {
  const config = loadConnectorsConfig(dataDir);
  const demo = readInstallationMode(dataDir) === 'demo';
  return DOMAINS.map((domain) => {
    const activeId = config[domain]?.active || 'mock';
    const connectedProviders = validProviderIdsFor(domain).filter(
      (providerId) => providerId !== 'mock' && isAnyInstanceConnected(providerId, dataDir)
    );
    // Mock is available only in demo mode. A real active provider is "connected"
    // only if the domain's resolved connection instance is itself connected.
    const instance = activeId === 'mock' ? null : resolveInstanceForDomain(activeId, config[domain]?.activeInstanceId, dataDir);
    const connected =
      activeId === 'mock'
        ? demo
        : isProviderInstanceConnected(activeId, instance, dataDir);
    const h = instance ? getSyncState(getDb(), instance.id, domain) : null;
    return {
      domain,
      active: activeId,
      // issue #163 PR 5: exposed so the frontend's per-domain instance
      // selector (public/components/u2-connectors.js) knows which instance
      // is currently selected, without re-deriving connectors.yaml's shape
      // itself. Never a secret -- just the same instance id already
      // returned in full by GET /api/connectors/:connectorId/instances.
      activeInstanceId: config[domain]?.activeInstanceId || null,
      connected,
      mode: demo ? 'demo' : 'personal',
      connectedProviders,
      availableProviders: validProviderIdsFor(domain),
      lastSyncAt: h?.lastSyncAt || null,
      lastError: h?.lastError || null,
    };
  });
}

function unavailable(domain, reason) {
  const error = new Error(`${domain} unavailable: ${reason}; connect or select a real account`);
  error.code = 'SERVICE_UNAVAILABLE';
  error.status = 503;
  return error;
}

export function getSyncState(db, instanceId, domain) {
  const row = db.prepare('SELECT last_sync_at, last_error FROM connection_sync_state WHERE instance_id = ? AND domain = ?').get(instanceId, domain);
  return row ? { lastSyncAt: row.last_sync_at, lastError: row.last_error } : null;
}

export function recordSyncSuccess(domain, instanceId, { db = getDb() } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO connection_sync_state (instance_id, domain, last_sync_at, last_error, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(instance_id, domain) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = NULL, updated_at = excluded.updated_at`)
    .run(instanceId, domain, now, now);
}

export function safeSyncError(err) {
  const read = googleReadFailureMetadata(err);
  if (read) {
    const status = read.status === undefined ? '' : ` (status ${read.status})`;
    if (read.kind === 'timeout') return 'Google sync timed out; check provider availability and retry later';
    if (read.kind === 'authorization') return `Google sync authorization failed${status}; reconnect this account`;
    if (read.kind === 'rate_limit') return `Google sync rate limited${status}; retry later`;
    if (read.status !== undefined) return `Google sync unavailable${status}; retry later`;
    return 'Sync failed; check account credentials and provider availability, then retry';
  }
  const message = err?.message || '';
  const providerStatus = /^(gmail|google-calendar|google-contacts): (?:syncChanges|searchContacts) failed \(status ([1-5][0-9]{2})\)$/.exec(message);
  if (providerStatus) {
    const [, provider, status] = providerStatus;
    if (status === '401' || status === '403') return `${provider}: authorization failed (status ${status}); reconnect this account`;
    if (status === '429') return `${provider}: rate limited (status 429); retry later`;
    if (status.startsWith('5')) return `${provider}: unavailable (status ${status}); retry later`;
    return `${provider}: sync failed (status ${status}); check account access`;
  }
  if (message === 'imap: inbox sync failed; check host, TLS, credentials, and mailbox access') return message;
  return 'Sync failed; check account credentials and provider availability, then retry';
}

export function recordSyncError(domain, instanceId, err, { db = getDb() } = {}) {
  const now = new Date().toISOString();
  const message = safeSyncError(err);
  db.prepare(`INSERT INTO connection_sync_state (instance_id, domain, last_sync_at, last_error, updated_at)
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(instance_id, domain) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .run(instanceId, domain, message, now);
  return message;
}

/** Test-only helper: clears warn-once state; persisted health belongs to each test DB. */
export function resetForTests() {
  warnedOnce.clear();
}

export function getRealProviderModule(providerId) {
  return REAL_PROVIDERS[providerId] || null;
}

export { DOMAINS };
