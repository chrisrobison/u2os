import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('a clean owner can create a named Google account and start OAuth for its instance', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    await page.locator('[data-catalog-id="google"]').click();
    const dialog = page.locator('u2-connector-setup dialog');
    await expect(dialog.locator('.connector-account-empty')).toContainText('No accounts yet.');
    const client = dialog.locator('form[data-connector-form]');
    await client.locator('input[name="clientId"]').fill('test.apps.googleusercontent.com');
    await client.locator('input[name="clientSecret"]').fill('PRIVATE_TEST_CLIENT_SECRET');
    await client.locator('button[type="submit"]').click();
    await expect(dialog).not.toBeVisible();

    await page.locator('[data-catalog-id="google"]').click();
    await dialog.locator('[data-show-add-account]').click();
    const add = dialog.locator('form[data-add-instance-form]');
    await expect(add.locator('input[name="clientId"]')).toHaveCount(0);
    await expect(add.locator('input[name="clientSecret"]')).toHaveCount(0);
    await add.locator('input[name="label"]').fill('Work Google');
    await add.locator('button[type="submit"]').click();
    const account = dialog.locator('.connector-account', { hasText: 'Work Google' });
    await expect(account).toBeVisible();
    const instanceId = await account.getAttribute('data-instance-id');

    let oauthUrl;
    await page.route('**/api/connectors/google/oauth/start?**', async (route) => {
      oauthUrl = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'OAuth intercepted' });
    });
    await account.locator('[data-google-service="gmail"]').click();
    await expect(page.getByText('OAuth intercepted')).toBeVisible();
    expect(oauthUrl.searchParams.get('service')).toBe('gmail');
    expect(oauthUrl.searchParams.get('instanceId')).toBe(instanceId);

    const list = await page.request.get(`${dedicated.baseURL}/api/connectors/google/instances`);
    expect(list.status()).toBe(200);
    const body = await list.text();
    expect(body).toContain('Work Google');
    expect(body).not.toContain('PRIVATE_TEST_CLIENT_SECRET');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
