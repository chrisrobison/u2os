// issue #163 PR 4 of 5: provider-registry.js/sync-scheduler.js now route a
// domain's calls through its resolved connection instance instead of a
// single hardcoded legacy vault file, and the 3 Google provider modules
// (plus, in principle, any other accountMode:'multiple' connector that
// turns an upstream id into a local row id) scope their generated ids per
// instance so two connected accounts of the same connector can never
// collide. This file covers what tests/provider-registry.test.js,
// tests/imap-provider.test.js, and tests/oauth-instance-binding.test.js
// don't already: the shared id-scoping helper itself, an end-to-end
// same-upstream-id collision across two connected instances, the
// grandfathered/non-grandfathered id-format split, and activeInstanceId
// actually changing which account a subsequent call operates against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { getProvider } from '../server/integrations/provider-registry.js';
import { syncChanges as gcalSyncChanges } from '../server/integrations/google-calendar-provider.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { isGrandfatheredInstance, scopedLocalId, unscopedUpstreamId } from '../server/integrations/connector-instance-ids.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-provider-instance-routing-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function insertConnectionInstance(db, { id, connectorId, vaultKey, metadata, status = 'connected' }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connection_instances (id, connector_id, label, status, vault_key, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, connectorId, `label-${id}`, status, vaultKey, JSON.stringify(metadata || {}), now, now);
  return db.prepare('SELECT * FROM connection_instances WHERE id = ?').get(id);
}

function fetchGoogleEventOnce(googleEventId) {
  return async (url) => {
    if (String(url).includes('singleEvents')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: googleEventId,
              summary: 'Standup',
              start: { dateTime: '2026-09-24T10:00:00Z' },
              end: { dateTime: '2026-09-24T10:30:00Z' },
              status: 'confirmed',
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// --- unit coverage for the shared helper ------------------------------

test('connector-instance-ids: isGrandfatheredInstance/scopedLocalId/unscopedUpstreamId', () => {
  const grandfathered = { id: 'conn_old', metadata: JSON.stringify({ migratedFrom: 'legacy-single-file' }) };
  const fresh = { id: 'conn_new', metadata: JSON.stringify({}) };
  const noMetadata = { id: 'conn_none', metadata: null };

  assert.equal(isGrandfatheredInstance(grandfathered), true);
  assert.equal(isGrandfatheredInstance(fresh), false);
  assert.equal(isGrandfatheredInstance(noMetadata), false);
  assert.equal(isGrandfatheredInstance(null), false);
  assert.equal(isGrandfatheredInstance(undefined), false);

  assert.equal(scopedLocalId('gcal_', grandfathered, 'evt123'), 'gcal_evt123');
  assert.equal(scopedLocalId('gcal_', fresh, 'evt123'), 'gcal_conn_new_evt123');
  assert.throws(() => scopedLocalId('gcal_', null, 'evt123'));

  assert.equal(unscopedUpstreamId('gcal_', grandfathered, 'gcal_evt123'), 'evt123');
  assert.equal(unscopedUpstreamId('gcal_', fresh, 'gcal_conn_new_evt123'), 'evt123');
  // A foreign-shaped id is returned unchanged rather than mangled.
  assert.equal(unscopedUpstreamId('gcal_', fresh, 'something-else'), 'something-else');
});

// --- the actual collision fix, end to end -------------------------------

test('a grandfathered instance keeps the OLD unprefixed local id format (existing synced rows never orphaned)', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const instance = insertConnectionInstance(db, {
      id: 'conn_grandfathered_gcal',
      connectorId: 'google',
      vaultKey: 'google__conn_grandfathered_gcal',
      metadata: { migratedFrom: 'legacy-single-file' },
    });
    storeTokens(instance.vault_key, 'calendar', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);

    const result = await gcalSyncChanges({
      db,
      dataDir: dir,
      instance,
      fetchImpl: fetchGoogleEventOnce('upstream-evt-1'),
    });
    assert.equal(result.synced, 1);

    const rows = db.prepare('SELECT id FROM calendar_events').all();
    assert.deepEqual(rows.map((r) => r.id), ['gcal_upstream-evt-1']);
  } finally {
    await cleanup(dir);
  }
});

test('a non-grandfathered instance generates instance-scoped local ids', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const instance = insertConnectionInstance(db, {
      id: 'conn_fresh_gcal',
      connectorId: 'google',
      vaultKey: 'google__conn_fresh_gcal',
      metadata: {},
    });
    storeTokens(instance.vault_key, 'calendar', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);

    const result = await gcalSyncChanges({
      db,
      dataDir: dir,
      instance,
      fetchImpl: fetchGoogleEventOnce('upstream-evt-1'),
    });
    assert.equal(result.synced, 1);

    const rows = db.prepare('SELECT id FROM calendar_events').all();
    assert.deepEqual(rows.map((r) => r.id), ['gcal_conn_fresh_gcal_upstream-evt-1']);
  } finally {
    await cleanup(dir);
  }
});

test('two connected google-calendar instances that both hand back the SAME upstream event id land as two distinct local rows, no collision', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const grandfathered = insertConnectionInstance(db, {
      id: 'conn_collision_old',
      connectorId: 'google',
      vaultKey: 'google__conn_collision_old',
      metadata: { migratedFrom: 'legacy-single-file' },
    });
    const fresh = insertConnectionInstance(db, {
      id: 'conn_collision_new',
      connectorId: 'google',
      vaultKey: 'google__conn_collision_new',
      metadata: {},
    });
    storeTokens(grandfathered.vault_key, 'calendar', { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }, dir);
    storeTokens(fresh.vault_key, 'calendar', { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }, dir);

    const sharedUpstreamId = 'shared-upstream-event-id';
    await gcalSyncChanges({ db, dataDir: dir, instance: grandfathered, fetchImpl: fetchGoogleEventOnce(sharedUpstreamId) });
    await gcalSyncChanges({ db, dataDir: dir, instance: fresh, fetchImpl: fetchGoogleEventOnce(sharedUpstreamId) });

    const rows = db.prepare('SELECT id FROM calendar_events').all().map((r) => r.id).sort();
    assert.deepEqual(rows, ['gcal_conn_collision_new_shared-upstream-event-id', 'gcal_shared-upstream-event-id'].sort());
    assert.equal(rows.length, 2, 'both instances\' events must be stored as distinct rows, never overwriting one another');
  } finally {
    await cleanup(dir);
  }
});

// --- switching activeInstanceId actually changes which account is used ---

async function post(origin, urlPath, body) {
  const res = await fetch(`${origin}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function minimalImapClient() {
  return {
    usable: true,
    mailbox: { exists: 0 }, // short-circuits syncChanges right after the mailbox lock, before any fetch iteration.
    async connect() {},
    async getMailboxLock() {
      return { release() {} };
    },
    async logout() {},
  };
}

test('switching a domain\'s activeInstanceId via POST /api/connectors/:domain/active changes which account a subsequent sync operates against', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    const instanceA = await post(origin, '/api/connectors/imap/instances', {
      label: 'Account A', host: 'a.example.com', username: 'alice', password: 'fixture-password-a',
    });
    const instanceB = await post(origin, '/api/connectors/imap/instances', {
      label: 'Account B', host: 'b.example.com', username: 'bob', password: 'fixture-password-b',
    });
    assert.equal(instanceA.status, 201);
    assert.equal(instanceB.status, 201);

    const activateA = await post(origin, '/api/connectors/email/active', {
      connectorId: 'imap', instanceId: instanceA.body.id, providerId: 'imap',
    });
    assert.equal(activateA.status, 200);

    const seenConfigsA = [];
    await getProvider('email', { dataDir: dir }).syncChanges({
      clientFactory: (config) => {
        seenConfigsA.push(config);
        return minimalImapClient();
      },
    });
    assert.equal(seenConfigsA.length, 1);
    assert.equal(seenConfigsA[0].host, 'a.example.com');
    assert.equal(seenConfigsA[0].auth.user, 'alice');

    const activateB = await post(origin, '/api/connectors/email/active', {
      connectorId: 'imap', instanceId: instanceB.body.id, providerId: 'imap',
    });
    assert.equal(activateB.status, 200);

    const seenConfigsB = [];
    await getProvider('email', { dataDir: dir }).syncChanges({
      clientFactory: (config) => {
        seenConfigsB.push(config);
        return minimalImapClient();
      },
    });
    assert.equal(seenConfigsB.length, 1);
    assert.equal(seenConfigsB[0].host, 'b.example.com');
    assert.equal(seenConfigsB[0].auth.user, 'bob');
  } finally {
    await cleanup(dir, handle);
  }
});

// --- google-contacts through getProvider() (the arity-wrapped path) -------
// The other google-* coverage above (grandfathered/non-grandfathered id
// format, two-instance collision) calls google-calendar-provider.js's
// syncChanges() directly with an explicit `instance` argument, which never
// exercises bindProviderToInstance()/OPTIONS_ARITY at all -- the wrapper
// that the agent's own report says it got wrong once already (a heuristic
// that silently corrupted brave-search's search()/webhook's send()
// payloads, caught only because THOSE call paths had test coverage).
// google-contacts had no test going through getProvider() either, so this
// closes that specific gap: real HTTP instance creation, real /active
// wiring, real getProvider() resolution, real OPTIONS_ARITY['google-contacts']
// injection, and the id-scoping fix, all through the actual production path.
test('google-contacts through getProvider("contacts") resolves the active instance and scopes upserted entity ids', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;
    const db = getDb();

    const created = await post(origin, '/api/connectors/google/instances', { label: 'Contacts account' });
    assert.equal(created.status, 201);
    const instanceId = created.body.id;
    const row = db.prepare('SELECT * FROM connection_instances WHERE id = ?').get(instanceId);
    storeTokens(row.vault_key, 'contacts', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);

    const activate = await post(origin, '/api/connectors/contacts/active', {
      connectorId: 'google', instanceId, providerId: 'google-contacts',
    });
    assert.equal(activate.status, 200);

    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        connections: [{ resourceName: 'people/c123', names: [{ displayName: 'Ada Lovelace' }], emailAddresses: [{ value: 'ada@example.com' }] }],
      }),
    });

    const provider = getProvider('contacts', { dataDir: dir });
    assert.equal(provider.id, 'google-contacts');
    const results = await provider.searchContacts({}, { fetchImpl });
    assert.equal(results.length, 1);
    // Non-grandfathered (created fresh via the CRUD API, no migratedFrom
    // tag) -> instance-scoped id, exactly as the direct-call gcal tests
    // above assert for google-calendar, now proven through the real
    // getProvider()/OPTIONS_ARITY path instead of a direct function call.
    assert.equal(results[0].id, `gc_${instanceId}_people_c123`);

    const fact = db.prepare('SELECT value FROM facts WHERE entity_id = ? AND key = ?').get(results[0].id, 'email');
    assert.equal(JSON.parse(fact.value), 'ada@example.com');
  } finally {
    await cleanup(dir, handle);
  }
});
