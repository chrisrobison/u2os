// Resolves, per domain, either the mock provider or a connected real
// provider, with graceful fallback to mock when a configured real connector
// isn't actually connected yet. Per docs/connectors.md's
// "server/integrations/provider-registry.js" section.
//
// The registry statically imports every provider module up front (the set
// is fixed for this phase -- no dynamic plugin loading yet) and re-reads
// connectors-config on every getProvider() call, so flipping the active
// provider in connectors.yaml (or via the API) takes effect on the very next
// call, with no server restart required.
import * as mockCalendar from './mock-calendar-provider.js';
import * as mockEmail from './mock-email-provider.js';
import * as mockContacts from './mock-contacts-provider.js';
import * as mockWeb from './mock-web-search-provider.js';
import * as mockNotifications from './mock-notifications-provider.js';
import * as googleCalendar from './google-calendar-provider.js';
import * as gmail from './gmail-provider.js';
import * as googleContacts from './google-contacts-provider.js';
import * as braveSearch from './brave-search-provider.js';
import * as webhookNotify from './webhook-notify-provider.js';
import { loadConnectorsConfig, validProviderIdsFor, DOMAINS } from './connectors-config.js';

const MOCK_PROVIDERS = {
  calendar: mockCalendar,
  email: mockEmail,
  contacts: mockContacts,
  web: mockWeb,
  notifications: mockNotifications,
};

// providerId -> module, for every REAL connector this phase implements.
// Ids named in connectors-config's VALID_PROVIDER_IDS but absent here
// (caldav, imap) simply have no module -- resolved as "always not
// connected", falling back to mock, no special-casing needed.
const REAL_PROVIDERS = {
  'google-calendar': googleCalendar,
  gmail,
  'google-contacts': googleContacts,
  'brave-search': braveSearch,
  webhook: webhookNotify,
};

// Logs a health warning once per (domain, providerId) pair per process,
// rather than spamming on every call.
const warnedOnce = new Set();

// In-memory health tracking: domain -> { lastSyncAt, lastError }. Populated
// by sync-scheduler.js (recordSyncSuccess/recordSyncError) and by provider
// call failures elsewhere. Deliberately NOT reset by getProvider() itself --
// only sync outcomes and explicit resets touch it.
const syncHealth = {};

function isRealProviderConnected(providerId, dataDir) {
  const real = REAL_PROVIDERS[providerId];
  if (!real || typeof real.isConnected !== 'function') return false;
  try {
    return !!real.isConnected(dataDir);
  } catch {
    return false;
  }
}

/**
 * getProvider(domain) -> the resolved provider module for that domain.
 * Domains: calendar, email, contacts, web, notifications.
 */
export function getProvider(domain, { dataDir } = {}) {
  const mockProvider = MOCK_PROVIDERS[domain];
  if (!mockProvider) throw new Error(`provider-registry: unknown domain "${domain}"`);

  const config = loadConnectorsConfig(dataDir);
  const activeId = config[domain]?.active || 'mock';

  if (activeId === 'mock') return mockProvider;

  if (isRealProviderConnected(activeId, dataDir)) {
    return REAL_PROVIDERS[activeId];
  }

  const warnKey = `${domain}:${activeId}`;
  if (!warnedOnce.has(warnKey)) {
    warnedOnce.add(warnKey);
    console.warn(
      `[provider-registry] domain "${domain}" is configured for "${activeId}" but that connector is not connected yet -- falling back to mock.`
    );
  }
  return mockProvider;
}

/** Returns the real provider module for `domain` ONLY if it's the
 * configured active provider AND currently connected, else null. Used by
 * sync-scheduler.js, which must never poll a mock or a not-yet-connected
 * real provider. */
export function resolveConnectedRealProvider(domain, { dataDir } = {}) {
  const config = loadConnectorsConfig(dataDir);
  const activeId = config[domain]?.active || 'mock';
  if (activeId === 'mock') return null;
  if (!isRealProviderConnected(activeId, dataDir)) return null;
  return REAL_PROVIDERS[activeId] || null;
}

/** GET /api/connectors' primary data source: per-domain status plus which
 * provider ids exist for that domain (for the UI to render toggles). Never
 * includes decrypted secrets -- only booleans and non-secret metadata. */
export function getHealth({ dataDir } = {}) {
  const config = loadConnectorsConfig(dataDir);
  return DOMAINS.map((domain) => {
    const activeId = config[domain]?.active || 'mock';
    // Mock is always available -- it never depends on external credentials,
    // so it is reported as connected.
    const connected = activeId === 'mock' ? true : isRealProviderConnected(activeId, dataDir);
    const h = syncHealth[domain] || {};
    return {
      domain,
      active: activeId,
      connected,
      availableProviders: validProviderIdsFor(domain),
      lastSyncAt: h.lastSyncAt || null,
      lastError: h.lastError || null,
    };
  });
}

export function recordSyncSuccess(domain) {
  syncHealth[domain] = { ...syncHealth[domain], lastSyncAt: new Date().toISOString(), lastError: null };
}

export function recordSyncError(domain, err) {
  // SECURITY: never store/log a decrypted credential or token here -- only
  // the error message, which provider modules keep secret-free (they throw
  // "<provider>: <operation> failed" style errors, never including token
  // values).
  syncHealth[domain] = { ...syncHealth[domain], lastError: err?.message || String(err) };
}

/** Test-only helper: clears warn-once and health state between test runs. */
export function resetForTests() {
  warnedOnce.clear();
  for (const key of Object.keys(syncHealth)) delete syncHealth[key];
}

export function getRealProviderModule(providerId) {
  return REAL_PROVIDERS[providerId] || null;
}

export { DOMAINS };
