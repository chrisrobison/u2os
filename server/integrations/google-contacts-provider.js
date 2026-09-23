// Real Google Contacts provider (People API v1, native fetch). Same
// function shape as mock-contacts-provider.js. Per docs/connectors.md's
// "Google Contacts provider" section.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { hasTokens, getValidAccessToken } from './oauth/google-oauth.js';

export const id = 'google-contacts';

const API_URL = 'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers';
const ID_PREFIX = 'gc_';

// Hardcodes the legacy 'google' vault key rather than resolving a specific
// connection instance -- full multi-instance-aware provider routing is
// issue #163 PR 4's job, not this one's. This keeps working unchanged for
// the single pre-migration `google` account any given installation has,
// exactly as before PR 3's google-oauth.js vaultKey change.
const LEGACY_VAULT_KEY = 'google';

export function isConnected(dataDir) {
  return hasTokens(LEGACY_VAULT_KEY, 'contacts', dataDir);
}

function sanitizeResourceName(resourceName) {
  return resourceName.replace(/[^a-zA-Z0-9]/g, '_');
}

function upsertEntity({ resourceName, name }) {
  const db = getDb();
  const localId = `${ID_PREFIX}${sanitizeResourceName(resourceName)}`;
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

export async function searchContacts({ query } = {}, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const token = await getValidAccessToken(LEGACY_VAULT_KEY, 'contacts', { dataDir, fetchImpl });
  const res = await fetchImpl(API_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`google-contacts: searchContacts failed (status ${res.status})`);
  const json = await res.json();
  const connections = json.connections || [];
  const results = [];
  for (const person of connections) {
    const name = person.names?.[0]?.displayName || null;
    if (query && name && !name.toLowerCase().includes(query.toLowerCase())) continue;
    const entityId = upsertEntity({ resourceName: person.resourceName, name });
    for (const email of person.emailAddresses || []) {
      upsertFact(entityId, 'email', email.value);
    }
    for (const phone of person.phoneNumbers || []) {
      upsertFact(entityId, 'phone', phone.value);
    }
    const db = getDb();
    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
    results.push({ ...row, attributes: JSON.parse(row.attributes || '{}') });
  }
  return results;
}

/** Polled by sync-scheduler.js -- contacts have no distinct "changed" event
 * type in docs/events.md, so syncChanges just re-runs the same upsert with
 * no query filter and returns a count; consumers reading entities/facts
 * directly pick up the refreshed data. */
export async function syncChanges({ eventBus, correlationId, fetchImpl = globalThis.fetch, dataDir } = {}) {
  const results = await searchContacts({}, { fetchImpl, dataDir });
  eventBus?.publish({
    type: 'contacts.synced',
    source: id,
    data: { count: results.length },
    metadata: { correlationId, provenance: 'sync:google-contacts' },
  });
  return { synced: results.length };
}
