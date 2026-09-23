import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const WEBHOOK_URL = 'https://notify.example.test/private-browser-topic';

test('owner can configure and select real notification delivery without exposing its URL', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Connectors' })).toBeVisible();

    await page.locator('[data-catalog-id="webhook"]').click();
    await page.locator('u2-connector-setup [data-show-add-account]').click();
    const credentials = page.locator('u2-connector-setup form[data-add-instance-form]');
    await credentials.locator('input[name="label"]').fill('Personal alerts');
    await credentials.locator('input[name="webhookUrl"]').fill(WEBHOOK_URL);
    await credentials.locator('select[name="format"]').selectOption('ntfy');
    await credentials.locator('button[type="submit"]').click();
    const account = page.locator('u2-connector-setup .connector-account', { hasText: 'Personal alerts' });
    await expect(account).toBeVisible();
    await account.locator('[data-use-instance]').click();

    const notifications = page.locator('u2-card[title="Notifications"]');
    await expect(notifications).toContainText('Personal alerts');
    await expect(notifications.locator('.connector-status')).toContainText('Webhook Notifications');
    await expect(notifications.locator('.status-dot')).toHaveClass(/is-connected/);

    const status = await page.request.get(`${dedicated.baseURL}/api/connectors`);
    const text = await status.text();
    expect(status.status()).toBe(200);
    expect(text).not.toContain('private-browser-topic');
    const entry = JSON.parse(text).connectors.find((item) => item.domain === 'notifications');
    expect(entry).toMatchObject({ active: 'webhook', connected: true });
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
