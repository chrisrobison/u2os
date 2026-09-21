import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('owner can inspect durable action delivery without seeing action payloads', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    await page.locator('.agent-panel__input').fill('Remind me to review the routine report.');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/operations"]').click();

    await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible();
    const card = page.locator('u2-operations .operation-card[data-status="completed"]').first();
    await expect(card).toContainText('tasks.create');
    await expect(card).toContainText('1 attempt');
    await expect(page.locator('u2-operations')).not.toContainText('review the routine report');
    await expect(page.locator('u2-operations')).not.toContainText('idempotency');
  } finally {
    await stopDedicatedServer(page, dedicated);
  }
});
