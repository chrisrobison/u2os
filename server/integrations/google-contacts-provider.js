// Real Google Contacts provider (People API v1, native fetch). Same
// function shape as mock-contacts-provider.js. Per docs/connectors.md's
// "Google Contacts provider" section.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { hasTokens, getValidAccessToken } from './oauth/google-oauth.js';
import { scopedLocalId } from './connector-instance-ids.js';
import { withGoogleRead } from './google-read-deadline.js';

export const id = 'google-contacts';

const API_URL = 'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers';
const ID_PREFIX = 'gc_';

/** `vaultKey` identifies which `google` connection instance to check (issue
 * #163 PR 4) -- required, no default, so a caller can never silently check
 * the wrong account. */
export function isConnected(vaultKey, dataDir) {
  return hasTokens(vaultKey, 'contacts', dataDir);
}

function sanitizeResourceName(resourceName) {
  return resourceName.replace(/[^a-zA-Z0-9]/g, '_');
}

function upsertEntity({ resourceName, name }, instance) {
  const db = getDb();
  const localId = scopedLocalId(ID_PREFIX, instance, sanitizeResourceName(resourceName));
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM entities WHERE id = ?').get(localId);
  if (existing) {
    db.prepare('UPDATE entities SET name = ?, updated_at = ? WHERE id = ?').run(name, now, localId);
  } else {
    db.prepare(
      `INSERT INTO entities (id, type, name, attributes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
    ).run(localId, 'Person', name, JSON.stringify({ resourceName }), 'active', now, now);
  }
  return localId;
}

function upsertFact(entityId, key, value) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT * FROM facts WHERE entity_id = ? AND key = ? AND source = ?')
    .get(entityId, key, id);
  if (existing) {
    db.prepare('UPDATE facts SET value = ?, last_confirmed_at = ? WHERE id = ?').run(JSON.stringify(value), now, existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, source, confidence, inferred, observed_at, last_confirmed_at, provenance, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(newId('fact'), entityId, key, JSON.stringify(value), id, 1.0, 0, now, now, JSON.stringify({}), now);
}

function connectionsFrom(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid contacts page');
  const connections = json.connections === undefined ? [] : json.connections;
  if (!Array.isArray(connections)) throw new Error('Invalid contacts page');
  // Validate the whole fetched page before importing any of it. Provider
  // fields are untrusted; missing identities must never become local IDs.
  for (const person of connections) {
    if (!person || typeof person.resourceName !== 'string' || !person.resourceName.trim()) {
      throw new Error('Invalid contact identity');
    }
    if (person.names !== undefined && (!Array.isArray(person.names) || person.names.some((name) =>
      !name || typeof name !== 'object' || Array.isArray(name) ||
      (name.displayName !== undefined && typeof name.displayName !== 'string')))) {
      throw new Error('Invalid contact names');
    }
    for (const field of ['emailAddresses', 'phoneNumbers']) {
      if (person[field] !== undefined && (!Array.isArray(person[field]) || person[field].some((entry) =>
        !entry || typeof entry.value !== 'string' || !entry.value.trim()))) {
        throw new Error('Invalid contact facts');
      }
    }
  }
  return connections;
}

export async function searchContacts({ query } = {}, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs, timers } = {}) {
  return withGoogleRead({ fetchImpl, timeoutMs, timers }, async ({ fetchImpl: boundedFetch, check }) => {
    const token = await getValidAccessToken(instance.vault_key, 'contacts', { dataDir, fetchImpl: boundedFetch });
    const res = await boundedFetch(API_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Contacts read unavailable');
    const connections = connectionsFrom(await res.json());
    check();
    const results = [];
    for (const person of connections) {
      const name = person.names?.[0]?.displayName || null;
      if (query && (!name || !name.toLowerCase().includes(query.toLowerCase()))) continue;
      check();
      const entityId = upsertEntity({ resourceName: person.resourceName, name }, instance);
      for (const email of person.emailAddresses || []) upsertFact(entityId, 'email', email.value);
      for (const phone of person.phoneNumbers || []) upsertFact(entityId, 'phone', phone.value);
      const row = getDb().prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
      results.push({ ...row, attributes: JSON.parse(row.attributes || '{}') });
    }
    return results;
  });
}

/** Polled by sync-scheduler.js -- contacts have no distinct "changed" event
 * type in docs/events.md, so syncChanges just re-runs the same upsert with
 * no query filter and returns a count; consumers reading entities/facts
 * directly pick up the refreshed data. */
export async function syncChanges({ eventBus, correlationId, fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs, timers } = {}) {
  const results = await searchContacts({}, { fetchImpl, dataDir, instance, timeoutMs, timers });
  eventBus?.publish({
    type: 'contacts.synced',
    source: id,
    data: { count: results.length },
    metadata: { correlationId, provenance: 'sync:google-contacts' },
  });
  return { synced: results.length };
}
