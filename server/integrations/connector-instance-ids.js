// Shared local-row-id scoping helper for issue #163 (multiple connection
// instances per connector). server/integrations/google-calendar-provider.js,
// gmail-provider.js, and google-contacts-provider.js each turn an
// upstream-provider-assigned id (a Google Calendar event id, a Gmail
// message id, a People API resourceName) into a locally-stored row id. Per
// docs/connectors.md's "ID convention" section that id is provider-prefixed
// (e.g. `gcal_<id>`) so ids never collide BETWEEN two different connector
// types -- but before issue #163, a connector could only ever have one
// connected account at a time, so nothing needed to distinguish two
// different accounts OF THE SAME connector. Once multiple connection
// instances of the same connector can be connected at once, two different
// accounts can hand back the same upstream id (e.g. two separate Gmail
// accounts can both have a message with id "18abc..."), and a naive
// `gmail_18abc...` local id would silently collide between them.
//
// Resolution (approved design -- issue #163 PR 4): exactly one instance per
// connector can ever be the "grandfathered" instance: the one
// server/integrations/connection-instances.js's one-time migration created
// from a pre-existing single-account installation (tagged
// metadata.migratedFrom === 'legacy-single-file'). That instance may already
// have real, existing synced rows under the OLD unprefixed id format, so it
// keeps generating unprefixed ids forever -- never orphaning or duplicating
// an existing owner's calendar/email data. Every other instance (created via
// the instance CRUD API -- whether it's a second account, or, on an
// installation with no migration history at all, literally every instance)
// never had pre-existing rows to protect, so it safely generates
// instance-scoped ids from the moment it's created.
export function isGrandfatheredInstance(instance) {
  if (!instance) return false;
  const raw = instance.metadata;
  if (raw == null) return false;
  try {
    const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return metadata?.migratedFrom === 'legacy-single-file';
  } catch {
    return false;
  }
}

/**
 * Builds the locally-stored row id for an upstream-provider-assigned id,
 * per the grandfathered/non-grandfathered rule above. `prefix` is the
 * connector's existing documented prefix (e.g. 'gcal_', 'gmail_', 'gc_').
 * `instance` must be the RAW connection_instances row (needs `.id` and
 * `.metadata`, not the secret-free API shape) -- provider-registry.js is
 * what resolves and passes it down to every instance-bound provider call.
 */
export function scopedLocalId(prefix, instance, upstreamId) {
  if (!instance || !instance.id) {
    throw new Error('scopedLocalId: a resolved connection instance is required');
  }
  return isGrandfatheredInstance(instance) ? `${prefix}${upstreamId}` : `${prefix}${instance.id}_${upstreamId}`;
}

/**
 * Reverses scopedLocalId(): strips whichever prefix form `instance` would
 * have produced, so a caller holding a localId it (or a prior sync) already
 * generated -- e.g. for a getEvent/reschedule call -- can recover the
 * upstream id without guessing which format was used. Returns `localId`
 * unchanged if it doesn't start with the expected prefix (defensive: a
 * stale/foreign id should fail the caller's own lookup rather than this
 * function silently mangling it).
 */
export function unscopedUpstreamId(prefix, instance, localId) {
  const scopedPrefix = isGrandfatheredInstance(instance) ? prefix : `${prefix}${instance.id}_`;
  return typeof localId === 'string' && localId.startsWith(scopedPrefix) ? localId.slice(scopedPrefix.length) : localId;
}
