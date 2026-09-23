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

    await page.locator('[data-catalog-id="smtp"]').click();
    await page.locator('u2-connector-setup [data-show-add-account]').click();
    const senderForm = page.locator('u2-connector-setup [data-add-instance-form]');
    await senderForm.locator('input[name="label"]').fill('Personal sender');
    await senderForm.locator('input[name="host"]').fill('smtp.example.test');
    await senderForm.locator('select[name="port"]').selectOption('587');
    await senderForm.locator('input[name="username"]').fill('owner@example.test');
    await senderForm.locator('input[name="password"]').fill('PRIVATE_SMTP_APP_PASSWORD');
    await senderForm.locator('input[name="from"]').fill('owner@example.test');
    await senderForm.locator('button[type="submit"]').click();
    await expect(page.locator('u2-connector-setup .connector-account', { hasText: 'Personal sender' })).toBeVisible();
    const smtp = (await (await page.request.get(`${dedicated.baseURL}/api/connectors/smtp/instances`)).json()).instances[0];
    await page.locator('u2-connector-setup [data-close]').click();

    await page.locator('[data-catalog-id="imap"]').click();
    await page.locator('u2-connector-setup [data-show-add-account]').click();
    const form = page.locator('u2-connector-setup form[data-add-instance-form]');
    await form.locator('input[name="label"]').fill('Personal mail');
    await form.locator('input[name="host"]').fill('mail.example.test');
    await form.locator('input[name="username"]').fill('owner@example.test');
    await form.locator('input[name="password"]').fill('PRIVATE_TEST_APP_PASSWORD');
    await form.locator('button[type="submit"]').click();
    const account = page.locator('u2-connector-setup .connector-account', { hasText: 'Personal mail' });
    await expect(account).toBeVisible();
    await account.locator('[data-smtp-pair-form] select').selectOption(smtp.id);
    await account.locator('[data-smtp-pair-form] button[type="submit"]').click();
    await expect(account.locator('[data-smtp-pair-form] select')).toHaveValue(smtp.id);
    const accountsResponse = await page.request.get(`${dedicated.baseURL}/api/connectors/imap/instances`);
    expect((await accountsResponse.json()).instances[0].smtpInstanceId).toBe(smtp.id);
    await account.locator('[data-use-instance]').click();

    const email = page.locator('u2-card[title="Email"]');
    await expect(email.locator('.status-dot')).toHaveClass(/is-connected/);
    await expect(email).toContainText('Personal mail');
    const status = await page.request.get(`${dedicated.baseURL}/api/connectors`);
    expect(await status.text()).not.toContain('PRIVATE_TEST_APP_PASSWORD');

    page.on('dialog', (dialog) => dialog.accept());
    await account.locator('[data-remove-instance]').click();
    await expect(account).toHaveCount(0);
    await expect(email.locator('.connector-status')).toContainText('Mock');
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
    await page.locator('u2-connector-setup [data-show-add-account]').click();
    const form = page.locator('u2-connector-setup form[data-add-instance-form]');
    await form.locator('input[name="label"]').fill('Personal sender');
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

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('u2-connector-setup [data-remove-instance]').click();
    await expect(page.locator('[data-catalog-id="smtp"] .status-dot')).toHaveClass(/is-disconnected/);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('two IMAP accounts can be selected and one removed without changing the other', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await page.locator('[data-catalog-id="imap"]').click();
    const dialog = page.locator('u2-connector-setup dialog');
    for (const label of ['Personal', 'Work']) {
      await dialog.locator('[data-show-add-account]').click();
      const form = dialog.locator('[data-add-instance-form]');
      await form.locator('[name="label"]').fill(label);
      await form.locator('[name="host"]').fill('mail.example.test');
      await form.locator('[name="username"]').fill(`${label.toLowerCase()}@example.test`);
      await form.locator('[name="password"]').fill(`PRIVATE_${label}_PASSWORD`);
      await form.locator('button[type="submit"]').click();
      await expect(dialog.locator('.connector-account', { hasText: label })).toBeVisible();
    }
    const personal = dialog.locator('.connector-account', { hasText: 'Personal' });
    const work = dialog.locator('.connector-account', { hasText: 'Work' });
    await personal.locator('[data-use-instance]').click();
    await expect(page.locator('u2-card[title="Email"]')).toContainText('Personal');
    await work.locator('[data-use-instance]').click();
    await expect(page.locator('u2-card[title="Email"]')).toContainText('Work');
    await work.locator('[data-reconnect-instance]').click();
    const reconnect = work.locator('[data-reconnect-form]');
    await reconnect.locator('[name="host"]').fill('mail.example.test');
    await reconnect.locator('[name="username"]').fill('work@example.test');
    await reconnect.locator('[name="password"]').fill('ROTATED_TEST_VALUE');
    await reconnect.locator('button[type="submit"]').click();
    await expect(work.locator('[data-reconnect-form]')).toHaveCount(0);

    page.on('dialog', (nativeDialog) => nativeDialog.accept());
    await personal.locator('[data-remove-instance]').click();
    await expect(personal).toHaveCount(0);
    await expect(work).toBeVisible();
    await expect(page.locator('u2-card[title="Email"]')).toContainText('Work');
    const response = await page.request.get(`${dedicated.baseURL}/api/connectors/imap/instances`);
    const body = await response.text();
    expect(body).toContain('Work');
    expect(body).not.toContain('PRIVATE_Work_PASSWORD');
    expect(body).not.toContain('ROTATED_TEST_VALUE');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
