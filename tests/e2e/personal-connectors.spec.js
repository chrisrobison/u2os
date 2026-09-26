import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { getDb } from '../../server/db/connection.js';
import { createConnectionInstance, findInstance } from '../../server/integrations/connection-instances.js';
import { storeTokens } from '../../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../../server/integrations/connectors-config.js';

test('personal connector status shows unavailable services without offering mock selection', async ({ browser }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.agent-panel__notice')).toContainText('Planner unavailable');
    await expect(page.locator('.agent-panel__input')).toBeDisabled();
    const email = page.locator('u2-card[title="Email"]');
    await expect(email).toContainText('No real account selected');
    await expect(email.locator('.status-dot')).toHaveClass(/is-disconnected/);
    await expect(email.locator('select option[value="mock"]')).toBeDisabled();
    await page.goto(`${dedicated.baseURL}/#/mail`);
    await expect(page.locator('.workspace__title', { hasText: 'Mail' })).toBeVisible();
    await expect(page.locator('.connector-meta', { hasText: 'Local cached records' })).toBeVisible();
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('held Google account retains encrypted credentials but shows disconnected services and reconnect controls', async ({ browser }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    const db = getDb(dedicated._dataDir);
    const account = createConnectionInstance(db, { connectorId: 'google', label: 'Held fixture account', status: 'disconnected', dataDir: dedicated._dataDir });
    const row = findInstance(db, 'google', account.id);
    storeTokens(row.vault_key, 'gmail', { access_token: 'isolated-browser-value', refresh_token: 'isolated-browser-value', expires_in: 3600 }, dedicated._dataDir);
    const config = loadConnectorsConfig(dedicated._dataDir);
    config.email = { active: 'gmail', activeInstanceId: account.id };
    saveConnectorsConfig(config, dedicated._dataDir);
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    const email = page.locator('u2-card[title="Email"]');
    await expect(email).toContainText('Disconnected');
    await expect(email.locator('.status-dot')).toHaveClass(/is-disconnected/);
    await page.locator('[data-catalog-id="google"]').click();
    const accountRow = page.locator('.connector-account', { hasText: 'Held fixture account' });
    await expect(accountRow.locator('[data-google-service="gmail"]')).toHaveText('Connect');
    await expect(accountRow.locator('[data-google-service="gmail"][data-google-action="disconnect"]')).toHaveCount(0);
    const response = await page.request.get(`${dedicated.baseURL}/api/connectors/google/instances`);
    const body = await response.text();
    expect(body).not.toContain('isolated-browser-value');
    expect(JSON.parse(body).instances[0].services.gmail).toBe(false);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
