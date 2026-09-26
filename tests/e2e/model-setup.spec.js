import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { readEncryptedFile } from '../../server/security/vault.js';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const passphrase = 'fixture-only personal model setup owner';
async function withPage(page, operation) {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  try {
    await createOwner(dedicated.baseURL, passphrase); await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(passphrase); await page.locator('form button[type="submit"]').click();
    await expect(page.locator('#workspace u2-dashboard')).toBeVisible(); await operation(dedicated);
  } finally { await stopDedicatedServer(page, dedicated); }
}
const open = (page) => page.locator('u2-nav a[data-route="#/model"]').click();
async function fill(page, secret = '') {
  await page.locator('u2-model input[name="baseUrl"]').fill('http://127.0.0.1:9');
  await page.locator('u2-model input[name="model"]').fill('fixture-unreachable-planner');
  await page.locator('u2-model input[name="apiKey"]').fill(secret);
}
async function api(page, payload) {
  return page.evaluate(async (value) => {
    const auth = await (await fetch('/api/auth/status')).json();
    const response = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-U2OS-CSRF': auth.csrfToken }, body: JSON.stringify(value) });
    return { status: response.status, result: await response.json() };
  }, payload);
}
const readConfig = (dedicated) => {
  const file = path.join(dedicated._dataDir, 'config', 'config.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

test('fresh personal owner saves encrypted model setup through notice, stays unavailable across browser reload, and adopts it only after explicit server restart', async ({ page }) => withPage(page, async (dedicated) => {
  await expect(page.locator('.agent-panel__input')).toBeDisabled(); await page.getByRole('link', { name: 'Model setup', exact: true }).click();
  await expect(page.locator('u2-model .model-status')).toContainText('requires configuration');
  const secret = 'fixture-model-key-not-browser-storage'; await fill(page, secret);
  await page.getByRole('button', { name: 'Save model configuration', exact: true }).click();
  await expect(page.locator('.model-save-status')).toContainText('Restart U2OS yourself'); await expect(page.locator('u2-model input[name="apiKey"]')).toHaveValue('');
  await expect(page.locator('.agent-panel__input')).toBeDisabled(); await expect(page.locator('.agent-panel')).toContainText('Model settings changed');
  expect(readConfig(dedicated)).not.toContain(secret); expect(readEncryptedFile('model-openai-compatible', dedicated._dataDir).apiKey).toBe(secret);
  const state = await page.evaluate(async () => ({ model: await (await fetch('/api/model')).json(), storage: JSON.stringify([localStorage, sessionStorage]) }));
  expect(JSON.stringify(state)).not.toContain(secret); expect(state.model.runtimePlannerStatus).toBe('configuration-required'); expect(state.model.restartRequired).toBe(true);
  await page.reload(); await expect(page.locator('u2-model .model-status')).toContainText('Restart is still required'); await expect(page.locator('.agent-panel__input')).toBeDisabled();
  await page.goto('about:blank'); await dedicated.handle.shutdown(); dedicated.handle = await startServer({ port: 0 }); dedicated.baseURL = `http://127.0.0.1:${dedicated.handle.port}`;
  await page.goto(`${dedicated.baseURL}/#/model`); await expect(page.locator('u2-model .model-status')).toContainText('reachability has not been checked');
  await expect(page.locator('.agent-panel__input')).toBeEnabled(); await expect(page.locator('u2-model input[name="apiKey"]')).toHaveValue('');
  expect(await page.evaluate(async () => (await (await fetch('/api/model')).json()).restartRequired)).toBe(false);
}));

test('a stale form cannot overwrite newer advanced roles/key, and reloaded advanced view is inert and read-only', async ({ page }) => withPage(page, async (dedicated) => {
  await open(page); await fill(page, 'fixture-unwanted-stale-key');
  const name = 'fixture-planner', advanced = { providers: { [name]: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'fixture-advanced', apiKey: 'fixture-advanced-key' } }, roles: { planner: name, response: name } };
  expect((await api(page, advanced)).status).toBe(200); const before = readConfig(dedicated), vaultBefore = fs.readFileSync(path.join(dedicated._dataDir, 'credentials', `model-provider-${name}.enc.json`), 'utf8');
  await page.getByRole('button', { name: 'Save model configuration', exact: true }).click();
  await expect(page.locator('.model-save-status')).toContainText('Save could not be confirmed'); await expect(page.locator('u2-model input[name="apiKey"]')).toHaveValue('');
  expect(readConfig(dedicated)).toBe(before); expect(fs.readFileSync(path.join(dedicated._dataDir, 'credentials', `model-provider-${name}.enc.json`), 'utf8')).toBe(vaultBefore);
  expect(readEncryptedFile('model-openai-compatible', dedicated._dataDir)).toBeNull();
  await page.reload(); await expect(page.locator('u2-model')).toContainText('Advanced model configuration is read-only');
  await expect(page.locator('u2-model')).toContainText(`planner: ${name}`); await expect(page.locator('u2-model form, u2-model input')).toHaveCount(0);
  await expect(page.locator('u2-model')).not.toContainText('fixture-advanced-key');
}));

test('invalid URL credentials/query and unavailable metadata cannot save or reflect private values', async ({ page }) => withPage(page, async () => {
  await open(page); await fill(page); let saves = 0;
  await page.route('**/api/model', (route) => { if (route.request().method() === 'POST') saves++; return route.continue(); });
  for (const url of ['http://fixture-user:fixture-secret@127.0.0.1:9', 'http://127.0.0.1:9?private=fixture-secret', 'https://fixture.example.test/#fixture-secret']) {
    await page.locator('u2-model input[name="baseUrl"]').fill(url); await page.locator('u2-model input[name="apiKey"]').fill('fixture-form-secret');
    await page.getByRole('button', { name: 'Save model configuration', exact: true }).click();
    await expect(page.locator('.model-save-status')).toContainText('No configuration change was attempted'); await expect(page.locator('u2-model input[name="apiKey"]')).toHaveValue('');
    await expect(page.locator('.model-save-status')).not.toContainText('fixture-secret');
  }
  expect(saves).toBe(0);
  await page.unroute('**/api/model'); await page.route('**/api/model', (route) => route.fulfill({ status: 503, json: { error: 'fixture-private-server-error' } }));
  await page.reload(); await expect(page.locator('u2-model')).toContainText('Could not load model configuration');
  await expect(page.locator('u2-model form')).toHaveCount(0); await expect(page.locator('u2-model')).not.toContainText('fixture-private');
}));

test('failed save clears secrets, offers no automatic retry, and checks metadata rather than reflecting private provider errors', async ({ page }) => withPage(page, async () => {
  await open(page); await fill(page, 'fixture-form-secret'); let saves = 0;
  await page.route('**/api/model', (route) => { if (route.request().method() !== 'POST') return route.continue(); saves++; return route.fulfill({ status: 500, json: { error: 'fixture-private-provider-error' } }); });
  await page.getByRole('button', { name: 'Save model configuration', exact: true }).click();
  await expect(page.locator('.model-save-status')).toContainText('no automatic retry or model request');
  await expect(page.locator('u2-model input[name="apiKey"]')).toHaveValue(''); await expect(page.locator('u2-model')).not.toContainText('fixture-private');
  await expect(page.getByRole('button', { name: 'Save model configuration', exact: true })).toBeDisabled(); expect(saves).toBe(1);
}));

test('leaving an unsaved view clears its detached key input without changing configuration', async ({ page }) => withPage(page, async (dedicated) => {
  await open(page); await fill(page, 'fixture-unsaved-key'); const before = readConfig(dedicated);
  await page.locator('u2-model input[name="apiKey"]').evaluate((field) => { window.fixtureDetachedKey = field; });
  await page.locator('u2-nav a[data-route="#/operations"]').click(); await expect(page.locator('u2-model')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureDetachedKey.value)).toBe(''); expect(readConfig(dedicated)).toBe(before);
}));

test('Anthropic setup uses existing default endpoint and does not create or expose a key when left blank', async ({ page }) => withPage(page, async (dedicated) => {
  await open(page); await page.locator('u2-model select[name="provider"]').selectOption('anthropic'); await page.locator('u2-model input[name="model"]').fill('fixture-anthropic-model');
  await page.getByRole('button', { name: 'Save model configuration', exact: true }).click(); await expect(page.locator('.model-save-status')).toContainText('Configuration saved');
  const config = JSON.parse(readConfig(dedicated)).model; expect(config.provider).toBe('anthropic'); expect(config.baseUrl).toBeUndefined(); expect(config.apiKey).toBeUndefined();
  expect(readEncryptedFile('model-anthropic', dedicated._dataDir)).toBeNull();
  await page.reload(); await expect(page.locator('u2-model select[name="provider"]')).toHaveValue('anthropic'); await expect(page.locator('.model-key-status')).toContainText('No key is reported');
}));

test('a saved POST with a lost confirmation disables the previously running composer after metadata refresh without retrying', async ({ page }) => withPage(page, async (dedicated) => {
  expect((await api(page, { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'fixture-original-model' })).status).toBe(200);
  await page.goto('about:blank'); await dedicated.handle.shutdown(); dedicated.handle = await startServer({ port: 0 }); dedicated.baseURL = `http://127.0.0.1:${dedicated.handle.port}`;
  await page.goto(dedicated.baseURL); await expect(page.locator('.agent-panel__input')).toBeEnabled(); await open(page); await fill(page); let saves = 0;
  await page.route('**/api/model', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saves++; const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.fulfill({ status: 500, json: { error: 'fixture-private-lost-save-confirmation' } });
  });
  await page.getByRole('button', { name: 'Save model configuration', exact: true }).click();
  await expect(page.locator('.model-save-status')).toContainText('Save could not be confirmed');
  await expect(page.locator('.agent-panel__input')).toBeDisabled(); await expect(page.locator('.agent-panel')).toContainText('Model settings changed');
  expect(saves).toBe(1); expect(JSON.parse(readConfig(dedicated)).model.model).toBe('fixture-unreachable-planner');
  await expect(page.locator('u2-model')).not.toContainText('fixture-private-lost-save-confirmation');
}));
