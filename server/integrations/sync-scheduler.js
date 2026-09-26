// Interval-based polling sync for connected real providers. Per
// docs/connectors.md's "server/integrations/sync-scheduler.js" section. Does
// NOT start a timer for any domain still on 'mock' or not connected, and
// re-resolves the connected provider on every tick so a mid-run
// disconnect/switch is respected without a restart.
//
// Instance-aware (issue #163 PR 4 of 5): resolveConnectedRealProvider()
// itself now resolves the domain's active connection instance
// (server/integrations/provider-registry.js's resolveInstanceForDomain) and
// returns a provider object already bound to that instance's vault key --
// so the provider.syncChanges({db, eventBus, correlationId, dataDir}) call
// below transparently runs against the correct account with no separate
// instance/vaultKey plumbing needed here. Switching a domain's
// activeInstanceId (the PR 2 /active route) takes effect on this module's
// very next tick, same as switching `active` itself always has.
import { newId } from '../db/ids.js';
import { loadConnectorsConfig, DOMAINS } from './connectors-config.js';
import { resolveConnectedRealProvider, recordSyncSuccess, recordSyncError, safeSyncError } from './provider-registry.js';
import { log } from '../logging/logger.js';
import path from 'node:path';
import fs from 'node:fs';
import { getDataDir } from '../db/connection.js';

const DEFAULT_INTERVAL_MINUTES = 5;

let timers = new Map(); // domain -> interval handle
const inFlight = new Map(); // canonical home/domain/provider/account -> shared operation
let timerGeneration = 0;

function clearTimers() {
  timerGeneration++;
  for (const handle of timers.values()) clearInterval(handle);
  timers.clear();
}

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
  clearTimers();
  dataDir ??= getDataDir();
  const generation = timerGeneration;
  const config = loadConnectorsConfig(dataDir);
  for (const domain of DOMAINS) {
    const provider = resolveConnectedRealProvider(domain, { dataDir });
    if (!provider || typeof provider.syncChanges !== 'function') continue;
    const intervalMs = intervalMsFor(domain, config);
    const handle = setInterval(() => {
      if (generation !== timerGeneration) return;
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

/** Clears intervals immediately, then drains already-started operations.
 * Does not cancel provider work, or block later explicit owner requests.
 * Timer reconciliation deliberately uses clearTimers instead: it preserves
 * in-flight identity without waiting or launching a retry/catch-up burst. */
export async function stopAll() {
  clearTimers();
  await Promise.allSettled([...inFlight.values()]);
}

async function runSync(domain, { db, eventBus, dataDir = getDataDir() } = {}) {
  const provider = resolveConnectedRealProvider(domain, { dataDir });
  if (!provider || typeof provider.syncChanges !== 'function') {
    throw new Error(`sync-scheduler: no connected provider with syncChanges for domain "${domain}"`);
  }
  const home = fs.realpathSync(path.resolve(dataDir));
  const key = JSON.stringify([home, domain, provider.id, provider.connectionInstanceId]);
  if (inFlight.has(key)) return inFlight.get(key);
  // Install bookkeeping before entering provider code (including synchronous
  // exceptions). No detached rejecting promise is created for cleanup.
  const operation = Promise.resolve().then(() => executeSync(domain, provider, { db, eventBus, dataDir }))
    .finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key); });
  inFlight.set(key, operation);
  return operation;
}

async function executeSync(domain, provider, { db, eventBus, dataDir }) {
  try {
    const result = await provider.syncChanges({ db, eventBus, correlationId: newId('corr'), dataDir });
    recordSyncSuccess(domain, provider.connectionInstanceId, { db });
    return result;
  } catch (err) {
    const safeError = safeSyncError(err);
    try {
      recordSyncError(domain, provider.connectionInstanceId, err, { db });
    } catch {
      // Unavailable health storage must not replace sanitized
      // failure with a raw database/provider exception or leak a flight.
      log.error('sync-scheduler', 'Sync health checkpoint unavailable');
    }
    // Unexpected provider messages may contain secrets. Only the allowlisted
    // or generic sanitized reason reaches health, logs, and the API.
    log.error('sync-scheduler', `sync failed for domain "${domain}"`, {
      domain,
      error: safeError,
    });
    throw new Error(safeError);
  }
}

/** Runs one syncChanges call immediately (the "Sync now" button / manual API
 * route). Returns its result, or throws if the domain has no real connected
 * provider with syncChanges -- the caller (the API route) turns that into a
 * 400. */
export async function triggerSync(domain, { db, eventBus, dataDir } = {}) {
  return runSync(domain, { db, eventBus, dataDir });
}
