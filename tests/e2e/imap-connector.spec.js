import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('owner can configure and disconnect IMAP without exposing its app password', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Connectors' })).toBeVisible();

    await page.locator('[data-catalog-id="imap"]').click();
    const form = page.locator('u2-connector-setup form[data-connector-form]');
    await form.locator('input[name="host"]').fill('mail.example.test');
    await form.locator('input[name="username"]').fill('owner@example.test');
    await form.locator('input[name="password"]').fill('PRIVATE_TEST_APP_PASSWORD');
    await form.locator('button[type="submit"]').click();
    await expect(page.locator('u2-connector-setup dialog')).not.toBeVisible();

    const email = page.locator('u2-card[title="Email"]');
    await email.locator('select[data-provider-domain="email"]').selectOption('imap');
    await expect(email.locator('.status-dot')).toHaveClass(/is-connected/);
    const status = await page.request.get(`${dedicated.baseURL}/api/connectors`);
    expect(await status.text()).not.toContain('PRIVATE_TEST_APP_PASSWORD');

    await page.locator('[data-catalog-id="imap"]').click();
    await page.locator('u2-connector-setup [data-disconnect]').click();
    await expect(email.locator('.status-dot')).toHaveClass(/is-disconnected/);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('owner can configure SMTP sending without exposing its app password', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Connectors' })).toBeVisible();

    await page.locator('[data-catalog-id="smtp"]').click();
    const form = page.locator('u2-connector-setup form[data-connector-form]');
    await form.locator('input[name="host"]').fill('smtp.example.test');
    await form.locator('select[name="port"]').selectOption('587');
    await form.locator('input[name="username"]').fill('owner@example.test');
    await form.locator('input[name="password"]').fill('PRIVATE_SMTP_APP_PASSWORD');
    await form.locator('input[name="from"]').fill('owner@example.test');
    await form.locator('button[type="submit"]').click();
    await expect(page.locator('[data-catalog-id="smtp"] .status-dot')).toHaveClass(/is-connected/);
    const status = await page.request.get(`${dedicated.baseURL}/api/connectors`);
    const text = await status.text();
    expect(text).not.toContain('PRIVATE_SMTP_APP_PASSWORD');
    expect(JSON.parse(text).smtpConfigured).toBe(true);

    await page.locator('[data-catalog-id="smtp"]').click();
    await page.locator('u2-connector-setup [data-disconnect]').click();
    await expect(page.locator('[data-catalog-id="smtp"] .status-dot')).toHaveClass(/is-disconnected/);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
