// Interval-based polling sync for connected real providers. Per
// docs/connectors.md's "server/integrations/sync-scheduler.js" section. Does
// NOT start a timer for any domain still on 'mock' or not connected, and
// re-resolves the connected provider on every tick so a mid-run
// disconnect/switch is respected without a restart.
import { newId } from '../db/ids.js';
import { loadConnectorsConfig, DOMAINS } from './connectors-config.js';
import { resolveConnectedRealProvider, recordSyncSuccess, recordSyncError } from './provider-registry.js';
import { log } from '../logging/logger.js';

const DEFAULT_INTERVAL_MINUTES = 5;

let timers = new Map(); // domain -> interval handle

function intervalMsFor(domain, config) {
  const minutes = config[domain]?.syncIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Starts one setInterval per domain that currently has a connected real
 * provider exposing syncChanges (calendar/email/contacts only -- web and
 * notifications are call-and-response, nothing to sync). Safe to call with
 * zero connectors configured: starts zero timers.
 */
export function startAll({ db, eventBus, dataDir } = {}) {
  stopAll();
  const config = loadConnectorsConfig(dataDir);
  for (const domain of DOMAINS) {
    const provider = resolveConnectedRealProvider(domain, { dataDir });
    if (!provider || typeof provider.syncChanges !== 'function') continue;
    const intervalMs = intervalMsFor(domain, config);
    const handle = setInterval(() => {
      runSync(domain, { db, eventBus, dataDir }).catch(() => {
        // runSync already records the error via recordSyncError; swallow
        // here so a rejected promise inside setInterval never becomes an
        // unhandled rejection.
      });
    }, intervalMs);
    timers.set(domain, handle);
  }
  return { started: [...timers.keys()] };
}

/** Re-read connector configuration after a runtime connect/disconnect or
 * provider switch and make the timer set match it immediately. */
export function reconcile(options = {}) {
  return startAll(options);
}

/** Clears every interval this module started. Call from tests' cleanup and
 * before the process exits so nothing keeps it alive. */
export function stopAll() {
  for (const handle of timers.values()) clearInterval(handle);
  timers.clear();
}

async function runSync(domain, { db, eventBus, dataDir } = {}) {
  const provider = resolveConnectedRealProvider(domain, { dataDir });
  if (!provider || typeof provider.syncChanges !== 'function') {
    throw new Error(`sync-scheduler: no connected provider with syncChanges for domain "${domain}"`);
  }
  try {
    const result = await provider.syncChanges({ db, eventBus, correlationId: newId('corr'), dataDir });
    recordSyncSuccess(domain);
    return result;
  } catch (err) {
    recordSyncError(domain, err);
    // SECURITY: err.message is guaranteed secret-free by provider modules
    // (see recordSyncError's comment above) -- safe to log in full.
    log.error('sync-scheduler', `sync failed for domain "${domain}"`, {
      domain,
      error: err?.message || String(err),
    });
    throw err;
  }
}

/** Runs one syncChanges call immediately (the "Sync now" button / manual API
 * route). Returns its result, or throws if the domain has no real connected
 * provider with syncChanges -- the caller (the API route) turns that into a
 * 400. */
export async function triggerSync(domain, { db, eventBus, dataDir } = {}) {
  return runSync(domain, { db, eventBus, dataDir });
}
