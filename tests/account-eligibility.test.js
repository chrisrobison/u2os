import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createConnectionInstance, findInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { readEncryptedFile } from '../server/security/vault.js';
import { getProvider, getHealth, captureAccountBinding, getProviderForBinding, resolveConnectedRealProvider, resolveInstanceForDomain } from '../server/integrations/provider-registry.js';
import { startServer } from './helpers/authed-server.js';

const VALUE = 'isolated-fixture-value';
async function fixture(run, { server = false, mode = 'personal' } = {}) {
  const previous = process.env.U2OS_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-eligibility-'));
  process.env.U2OS_HOME = home;
  let handle;
  try {
    ensureInstallationMode(mode, home);
    if (server) handle = await startServer({ mode, port: 0 });
    const db = getDb();
    const add = (connectorId, credentials) => createConnectionInstance(db, { connectorId, label: 'Fixture account', status: 'connected', credentials, dataDir: home });
    const google = add('google', null);
    const googleRow = findInstance(db, 'google', google.id);
    for (const service of ['calendar','gmail','contacts']) storeTokens(googleRow.vault_key, service, { access_token: VALUE, refresh_token: VALUE, expires_in: 3600 }, home);
    const imap = add('imap', { host: 'imap.example.test', username: 'fixture@example.test', password: VALUE });
    const web = add('brave-search', { apiKey: VALUE });
    const notifications = add('webhook', { webhookUrl: `https://notify.example.test/${VALUE}`, format: 'json' });
    const accounts = [['calendar','google-calendar',google], ['email','gmail',google], ['contacts','google-contacts',google], ['web','brave-search',web], ['notifications','webhook',notifications]];
    const select = (domain, providerId, instanceId) => {
      const config = loadConnectorsConfig(home); config[domain] = { active: providerId, activeInstanceId: instanceId }; saveConnectorsConfig(config, home);
    };
    accounts.forEach(([domain, provider, account]) => select(domain, provider, account.id));
    await run({ home, db, accounts, imap, web, notifications, select, handle });
  } finally {
    if (handle) await handle.shutdown();
    closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const status of ['pending','disconnected','error','recovery_review_required','future-unknown-status']) {
  test(`retained credentials cannot enable ${status} accounts across registry boundaries`, () => fixture(async ({ home, db, accounts, imap, select }) => {
    const bindings = accounts.map(([domain]) => captureAccountBinding(domain, { dataDir: home }));
    db.prepare('UPDATE connection_instances SET status = ?').run(status);
    for (const [index, [domain, providerId, account]] of accounts.entries()) {
      assert.throws(() => getProvider(domain, { dataDir: home }), { code: 'SERVICE_UNAVAILABLE' });
      assert.equal(resolveConnectedRealProvider(domain, { dataDir: home }), null);
      assert.throws(() => captureAccountBinding(domain, { dataDir: home }), /connect or select/);
      assert.throws(() => getProviderForBinding(domain, bindings[index], { dataDir: home }), /no action was attempted/);
      assert.equal(resolveInstanceForDomain(providerId, null, home), null);
      assert.equal(resolveInstanceForDomain(providerId, account.id, home).id, account.id);
      const health = getHealth({ dataDir: home }).find((entry) => entry.domain === domain);
      assert.equal(health.connected, false); assert.deepEqual(health.connectedProviders, []);
      assert.ok(!JSON.stringify(health).includes(VALUE));
      assert.ok(readEncryptedFile(findInstance(db, account.connectorId, account.id).vault_key, home));
    }
    select('email', 'imap', imap.id);
    assert.throws(() => getProvider('email'), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(resolveConnectedRealProvider('email'), null);
    assert.equal(resolveInstanceForDomain('imap', null, home), null);
  }));
}

test('explicit disabled selection never borrows another connected account; implicit selection excludes it', () => fixture(async ({ home, db, web, select }) => {
  const other = createConnectionInstance(db, { connectorId: 'brave-search', label: 'Other fixture', status: 'connected', credentials: { apiKey: VALUE }, dataDir: home });
  db.prepare("UPDATE connection_instances SET status = 'disconnected' WHERE id = ?").run(web.id);
  assert.throws(() => getProvider('web'), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(resolveInstanceForDomain('brave-search', null, home).id, other.id);
  select('web', 'brave-search', other.id);
  assert.equal(getProvider('web').connectionInstanceId, other.id);
  assert.equal(captureAccountBinding('web').instanceId, other.id);
}));

test('active API refuses retained credentials until explicit credential reconnection; rename is not reconnect', () => fixture(async ({ db, notifications, handle }) => {
  const origin = `http://127.0.0.1:${handle.port}`;
  const send = async (url, method, body) => {
    const res = await fetch(`${origin}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const row = findInstance(db, 'webhook', notifications.id);
  db.prepare("UPDATE connection_instances SET status = 'disconnected' WHERE id = ?").run(row.id);
  const selection = { providerId: 'webhook', connectorId: 'webhook', instanceId: row.id };
  const denied = await send('/api/connectors/notifications/active', 'POST', selection);
  assert.equal(denied.status, 400); assert.match(denied.body.error, /disconnected/); assert.ok(!JSON.stringify(denied).includes(VALUE));
  const renamed = await send(`/api/connectors/webhook/instances/${row.id}`, 'PATCH', { label: 'Renamed fixture' });
  assert.equal(renamed.body.status, 'disconnected');
  assert.equal(findInstance(db, 'webhook', row.id).credential_revision, row.credential_revision);
  const reconnected = await send(`/api/connectors/webhook/instances/${row.id}`, 'PATCH', { webhookUrl: `https://notify.example.test/${VALUE}`, format: 'json' });
  assert.equal(reconnected.body.status, 'connected');
  assert.equal(findInstance(db, 'webhook', row.id).credential_revision, row.credential_revision + 1);
  assert.equal((await send('/api/connectors/notifications/active', 'POST', selection)).status, 200);
  assert.equal(getProvider('notifications').connectionInstanceId, row.id);
}, { server: true }));

test('only explicit demo homes may use fallback for a held real account; bound real execution still refuses', () => fixture(async ({ db, notifications, home }) => {
  const binding = captureAccountBinding('notifications');
  db.prepare("UPDATE connection_instances SET status = 'disconnected' WHERE id = ?").run(notifications.id);
  assert.equal(getProvider('notifications').id, 'mock-notifications');
  assert.equal(resolveConnectedRealProvider('notifications'), null);
  assert.throws(() => getProviderForBinding('notifications', binding, { dataDir: home }), /no action was attempted/);
}, { mode: 'demo' }));

test('Google service API hides retained service connectivity and disconnect cannot enable a held account', () => fixture(async ({ db, accounts, handle }) => {
  const account = accounts[0][2];
  const origin = `http://127.0.0.1:${handle.port}`;
  db.prepare("UPDATE connection_instances SET status = 'disconnected' WHERE id = ?").run(account.id);
  const list = await (await fetch(`${origin}/api/connectors/google/instances`)).json();
  assert.deepEqual(list.instances[0].services, { calendar: false, gmail: false, contacts: false });
  const res = await fetch(`${origin}/api/connectors/google/instances/${account.id}/disconnect?service=gmail`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(findInstance(db, 'google', account.id).status, 'disconnected');
  assert.equal(resolveConnectedRealProvider('calendar'), null);
  assert.ok(!JSON.stringify(await res.json()).includes(VALUE));
}, { server: true }));
