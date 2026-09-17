import crypto from 'node:crypto';

/**
 * Generates a monotonic-ish, sortable, prefixed id, e.g. newId('evt') ->
 * "evt_lz3k9f2ab12cd34e". Timestamp-first so ids sort chronologically by
 * string comparison; the trailing UUID slice guarantees uniqueness even for
 * ids minted within the same millisecond.
 */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
}
