import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

for (const [label, query] of [['failure', 'error=connect_failed'], ['unknown error', 'error=PRIVATE_FIXTURE_UPSTREAM_TEXT'], ['unknown service', 'connected=PRIVATE_FIXTURE_UNKNOWN_SERVICE']]) {
  test(`OAuth notice ${label} gives fixed retry guidance without reflecting private query text`, async ({ browser }) => {
    const dedicated = await startDedicatedServer();
    const passphrase = 'fixture-only OAuth notice passphrase';
    await createOwner(dedicated.baseURL, passphrase);
    const context = await browser.newContext(), page = await context.newPage();
    try {
      await page.goto(`${dedicated.baseURL}/#/connectors?${query}`);
      await page.locator('input[name="passphrase"]').fill(passphrase);
      await page.locator('form button[type="submit"]').click();
      const notice = page.locator('u2-connectors u2-alert');
      await expect(notice).toContainText('Google connection was not confirmed');
      await expect(notice).toContainText('Review the intended account and OAuth client');
      await expect(notice).toContainText('there is no automatic retry');
      await expect(page.locator('u2-connectors')).not.toContainText('PRIVATE_FIXTURE');
      await expect(page).toHaveURL(/#\/connectors$/);
      await page.reload(); await expect(page.locator('u2-connectors .connector-table')).toBeVisible();
      await expect(page.locator('u2-connectors u2-alert')).toHaveCount(0);
    } finally { await context.close(); await stopDedicatedServer(null, dedicated); }
  });
}
