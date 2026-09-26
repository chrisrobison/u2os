import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearTokens, getValidAccessToken, storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { deleteEncryptedFile, readEncryptedFile, writeEncryptedFile } from '../server/security/vault.js';

const account = 'google__fixture_account';
const expired = { access_token: 'fixture-old-access', refresh_token: 'fixture-refresh', expires_in: -1 };
function delayed() {
  let complete;
  const promise = new Promise((resolve) => { complete = resolve; });
  return { fetchImpl: () => promise, complete: (access = 'fixture-late-access') => complete({ ok: true, json: async () => ({ access_token: access, expires_in: 3600 }) }) };
}
async function home(operation) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-refresh-race-'));
  try {
    writeEncryptedFile('google', { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, dataDir);
    storeTokens(account, 'gmail', expired, dataDir);
    await operation(dataDir);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}
const changes = [
  ['service disconnect', (dir) => clearTokens(account, 'gmail', dir)],
  ['account removal', (dir) => deleteEncryptedFile(account, dir)],
  ['reconnected access token', (dir) => storeTokens(account, 'gmail', { ...expired, access_token: 'fixture-reconnected-access', expires_in: 3600 }, dir)],
  ['replaced refresh token', (dir) => storeTokens(account, 'gmail', { ...expired, refresh_token: 'fixture-reconnected-refresh' }, dir)],
  ['shared OAuth client replacement', (dir) => writeEncryptedFile('google', { clientId: 'fixture-new-client', clientSecret: 'fixture-new-secret' }, dir)],
];
for (const [label, change] of changes) {
  test(`Google refresh discards a late result after ${label} without changing current vault bytes`, () => home(async (dataDir) => {
    const transport = delayed();
    const pending = getValidAccessToken(account, 'gmail', { dataDir, fetchImpl: transport.fetchImpl });
    change(dataDir);
    const file = path.join(dataDir, 'credentials', `${account}.enc.json`);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const clientBefore = fs.readFileSync(path.join(dataDir, 'credentials', 'google.enc.json'));
    transport.complete();
    await assert.rejects(pending, (error) => {
      assert.equal(error.message, 'google-oauth: credentials changed during refresh; retry with the selected connected account');
      assert.doesNotMatch(error.message, /fixture-|Bearer/);
      return true;
    });
    if (before === null) assert.equal(fs.existsSync(file), false);
    else assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'credentials', 'google.enc.json')), clientBefore);
  }));
}

test('Google refresh rejects an older concurrent result instead of overwriting the first completed refresh', () => home(async (dataDir) => {
  const first = delayed(), second = delayed();
  const old = getValidAccessToken(account, 'gmail', { dataDir, fetchImpl: first.fetchImpl });
  const newer = getValidAccessToken(account, 'gmail', { dataDir, fetchImpl: second.fetchImpl });
  second.complete('fixture-newer-access'); assert.equal(await newer, 'fixture-newer-access');
  const file = path.join(dataDir, 'credentials', `${account}.enc.json`), before = fs.readFileSync(file);
  first.complete(); await assert.rejects(old, /credentials changed during refresh/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(readEncryptedFile(account, dataDir).tokens.gmail.access_token, 'fixture-newer-access');
}));

test('Google refresh preserves unrelated service edits and another account without rejecting a valid refresh', () => home(async (dataDir) => {
  const transport = delayed();
  const pending = getValidAccessToken(account, 'gmail', { dataDir, fetchImpl: transport.fetchImpl });
  storeTokens(account, 'calendar', { access_token: 'fixture-calendar', refresh_token: 'fixture-calendar-refresh', expires_in: 7200 }, dataDir);
  const calendar = readEncryptedFile(account, dataDir).tokens.calendar;
  storeTokens('google__fixture_other', 'gmail', expired, dataDir);
  const otherFile = path.join(dataDir, 'credentials', 'google__fixture_other.enc.json'), otherBefore = fs.readFileSync(otherFile);
  transport.complete(); assert.equal(await pending, 'fixture-late-access');
  assert.deepEqual(readEncryptedFile(account, dataDir).tokens.calendar, calendar);
  assert.deepEqual(fs.readFileSync(otherFile), otherBefore);
  assert.equal(readEncryptedFile(account, dataDir).tokens.gmail.refresh_token, expired.refresh_token);
}));

test('Google refresh also refuses replacement of legacy account-local OAuth client credentials', () => home(async (dataDir) => {
  deleteEncryptedFile('google', dataDir);
  writeEncryptedFile(account, { ...readEncryptedFile(account, dataDir), clientId: 'fixture-local-id', clientSecret: 'fixture-local-secret' }, dataDir);
  const transport = delayed();
  const pending = getValidAccessToken(account, 'gmail', { dataDir, fetchImpl: transport.fetchImpl });
  writeEncryptedFile(account, { ...readEncryptedFile(account, dataDir), clientId: 'fixture-local-new-id', clientSecret: 'fixture-local-new-secret' }, dataDir);
  const file = path.join(dataDir, 'credentials', `${account}.enc.json`), before = fs.readFileSync(file);
  transport.complete(); await assert.rejects(pending, /credentials changed during refresh/);
  assert.deepEqual(fs.readFileSync(file), before);
}));
