import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEncryptedFile, readEncryptedFile } from '../server/security/vault.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { ensureConnectionInstancesMigrated, associateSmtpInstance, findInstance } from '../server/integrations/connection-instances.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-conninst-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function rows(db, connectorId) {
  return db.prepare('SELECT * FROM connection_instances WHERE connector_id = ?').all(connectorId);
}

test('fresh install with no legacy credential files: migration creates zero rows and does not throw', () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const results = ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.equal(results.every((r) => r.migrated === false), true);
    const count = db.prepare('SELECT COUNT(*) AS n FROM connection_instances').get().n;
    assert.equal(count, 0);
  } finally {
    cleanup(dir);
  }
});

test('each of the 5 legacy connector types is migrated into exactly one row, vault content readable under the new key', () => {
  const dir = tempHome();
  try {
    const google = {
      clientId: 'client-abc',
      clientSecret: 'shh-secret',
      tokens: { calendar: { access_token: 'at', refresh_token: 'rt', expiry: Date.now() + 3600_000 } },
    };
    const imap = { host: 'imap.example.com', port: 993, username: 'me@example.com', password: 'app-password' };
    const smtp = { host: 'smtp.example.com', port: 587, username: 'me@example.com', password: 'app-password', from: 'me@example.com' };
    const braveSearch = { apiKey: 'brave-api-key-value' };
    const webhook = { webhookUrl: 'https://ntfy.sh/some-topic', format: 'ntfy' };

    writeEncryptedFile('google', google, dir);
    writeEncryptedFile('imap', imap, dir);
    writeEncryptedFile('smtp', smtp, dir);
    writeEncryptedFile('web-search', braveSearch, dir);
    writeEncryptedFile('notify-webhook', webhook, dir);

    const db = getDb();
    const results = ensureConnectionInstancesMigrated({ db, dataDir: dir });

    assert.equal(results.filter((r) => r.migrated).length, 5);

    const expectations = [
      { connectorId: 'google', original: google, expectedStatus: 'connected' },
      { connectorId: 'imap', original: imap, expectedStatus: 'connected' },
      { connectorId: 'smtp', original: smtp, expectedStatus: 'connected' },
      { connectorId: 'brave-search', original: braveSearch, expectedStatus: 'connected' },
      { connectorId: 'webhook', original: webhook, expectedStatus: 'connected' },
    ];

    for (const { connectorId, original, expectedStatus } of expectations) {
      const found = rows(db, connectorId);
      assert.equal(found.length, 1, `expected exactly one row for ${connectorId}`);
      const row = found[0];
      assert.equal(row.connector_id, connectorId);
      assert.ok(row.label && row.label.length > 0, `label must be non-empty for ${connectorId}`);
      assert.equal(row.status, expectedStatus);
      const metadata = JSON.parse(row.metadata);
      assert.equal(metadata.migratedFrom, 'legacy-single-file');

      const decrypted = readEncryptedFile(row.vault_key, dir);
      assert.deepEqual(decrypted, original);
    }

    // imap/smtp get a "<user>@<host>" label; the others get "<Name> (migrated)".
    assert.equal(rows(db, 'imap')[0].label, 'me@example.com@imap.example.com');
    assert.equal(rows(db, 'smtp')[0].label, 'me@example.com@smtp.example.com');
    assert.equal(rows(db, 'google')[0].label, 'Google (migrated)');
    assert.equal(rows(db, 'brave-search')[0].label, 'Brave Search (migrated)');
    assert.equal(rows(db, 'webhook')[0].label, 'Webhook notifications (migrated)');

    // Google keeps a shared client-only file for newly connected accounts.
    assert.deepEqual(readEncryptedFile('google', dir), { clientId: google.clientId, clientSecret: google.clientSecret });
    assert.equal(rows(db, 'imap')[0].smtp_instance_id, rows(db, 'smtp')[0].id);
    assert.equal(readEncryptedFile('smtp', dir), null);
    // Other legacy files are removed after their instance copies are verified.
    for (const legacyName of ['imap', 'web-search', 'notify-webhook']) {
      assert.equal(
        fs.existsSync(path.join(dir, 'credentials', `${legacyName}.enc.json`)),
        false,
        `legacy file ${legacyName}.enc.json should be deleted after successful migration`
      );
    }
    ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.deepEqual(readEncryptedFile('google', dir), { clientId: google.clientId, clientSecret: google.clientSecret });
    associateSmtpInstance(db, { imapRow: findInstance(db, 'imap', rows(db, 'imap')[0].id), smtpInstanceId: null });
    ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.equal(rows(db, 'imap')[0].smtp_instance_id, null, 'explicit unpairing survives repeated migration');
  } finally {
    cleanup(dir);
  }
});

test('an upgraded global SMTP file reconciles into the migrated instance before removal', () => {
  const dir = tempHome();
  try {
    const original = { host: 'smtp.example.test', port: 587, username: 'owner@example.test', password: 'old-fixture', from: 'owner@example.test' };
    writeEncryptedFile('smtp', original, dir);
    const db = getDb();
    ensureConnectionInstancesMigrated({ db, dataDir: dir });
    const row = rows(db, 'smtp')[0];
    const newer = { ...original, password: 'new-fixture', from: 'new@example.test' };
    writeEncryptedFile('smtp', newer, dir);
    ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.deepEqual(readEncryptedFile(row.vault_key, dir), newer);
    assert.equal(rows(db, 'smtp')[0].credential_revision, 1);
    assert.equal(readEncryptedFile('smtp', dir), null);
    writeEncryptedFile('smtp', {}, dir);
    ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.deepEqual(readEncryptedFile(row.vault_key, dir), {});
    assert.equal(rows(db, 'smtp')[0].status, 'pending');
    assert.equal(rows(db, 'smtp')[0].credential_revision, 2);
  } finally { cleanup(dir); }
});

test('running the migration twice in a row (simulating two boots) does not duplicate rows or throw', () => {
  const dir = tempHome();
  try {
    writeEncryptedFile('imap', { host: 'imap.example.com', username: 'me@example.com', password: 'app-password' }, dir);
    writeEncryptedFile('web-search', { apiKey: 'brave-api-key-value' }, dir);

    const db = getDb();
    const first = ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.equal(first.filter((r) => r.migrated).length, 2);

    const second = ensureConnectionInstancesMigrated({ db, dataDir: dir });
    assert.equal(second.every((r) => r.migrated === false), true);
    assert.ok(second.some((r) => r.connectorId === 'imap' && r.reason === 'already-migrated'));
    assert.ok(second.some((r) => r.connectorId === 'brave-search' && r.reason === 'already-migrated'));

    assert.equal(rows(db, 'imap').length, 1);
    assert.equal(rows(db, 'brave-search').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('a legacy file that decrypts to {} (empty) is treated as not configured and produces no row', () => {
  const dir = tempHome();
  try {
    // Mirrors what the disconnect routes in server/api/routes/connectors.js
    // actually do: write back an empty object rather than delete the file.
    writeEncryptedFile('smtp', {}, dir);

    const db = getDb();
    const results = ensureConnectionInstancesMigrated({ db, dataDir: dir });
    const smtpResult = results.find((r) => r.connectorId === 'smtp');
    assert.equal(smtpResult.migrated, false);
    assert.equal(smtpResult.reason, 'not-configured');
    assert.equal(rows(db, 'smtp').length, 0);

    // An empty-but-present legacy file is left alone (not deleted, not
    // treated as a migration target) -- only a successfully migrated file
    // is ever deleted.
    assert.equal(fs.existsSync(path.join(dir, 'credentials', 'smtp.enc.json')), true);
  } finally {
    cleanup(dir);
  }
});

test('activeInstanceId is set on the relevant connectors.yaml domain(s) after migration', () => {
  const dir = tempHome();
  try {
    const config = loadConnectorsConfig(dir);
    config.web.active = 'brave-search';
    config.notifications.active = 'webhook';
    config.email.active = 'imap';
    config.calendar.active = 'google-calendar';
    saveConnectorsConfig(config, dir);

    writeEncryptedFile('web-search', { apiKey: 'brave-api-key-value' }, dir);
    writeEncryptedFile('notify-webhook', { webhookUrl: 'https://ntfy.sh/topic' }, dir);
    writeEncryptedFile('imap', { host: 'imap.example.com', username: 'me@example.com', password: 'pw' }, dir);
    writeEncryptedFile(
      'google',
      { clientId: 'c', clientSecret: 's', tokens: { calendar: { access_token: 'a', refresh_token: 'r', expiry: Date.now() + 1000 } } },
      dir
    );

    const db = getDb();
    const results = ensureConnectionInstancesMigrated({ db, dataDir: dir });

    const braveResult = results.find((r) => r.connectorId === 'brave-search');
    const webhookResult = results.find((r) => r.connectorId === 'webhook');
    const imapResult = results.find((r) => r.connectorId === 'imap');
    const googleResult = results.find((r) => r.connectorId === 'google');

    const updated = loadConnectorsConfig(dir);
    assert.equal(updated.web.activeInstanceId, braveResult.instanceId);
    assert.equal(updated.notifications.activeInstanceId, webhookResult.instanceId);
    assert.equal(updated.email.activeInstanceId, imapResult.instanceId);
    // google's catalog setup.services maps the calendar domain's active
    // provider id 'google-calendar' back to the 'google' connector, so the
    // calendar domain's activeInstanceId is set to the migrated google
    // instance even though config.calendar.active !== 'google' literally.
    assert.equal(updated.calendar.activeInstanceId, googleResult.instanceId);
  } finally {
    cleanup(dir);
  }
});
