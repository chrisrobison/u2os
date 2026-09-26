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

test('restored operation metadata explains unknown outcome without claiming failed delivery or exposing payloads', async ({ page }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.route('**/api/actions/operations', (route) => route.fulfill({ json: {
      items: [{ id: 'fixture-restored-operation', tool: 'notifications.send', status: 'failed', attemptCount: 1,
        errorClass: 'recovery_review_required', arguments: { body: 'fixture private archived payload' } }], counts: { failed: 1 },
    } }));
    await page.goto(dedicated.baseURL); await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click(); await page.locator('u2-nav a[data-route="#/operations"]').click();
    const card = page.locator('u2-operations .operation-card').first();
    await expect(card).toContainText('outcome unknown from restored snapshot'); await expect(card).toContainText('1 recorded attempt');
    await expect(card).toContainText('Archived approval cannot be retried'); await expect(card).not.toContainText('private archived payload');
    await expect(card.locator('.operation-card__meta')).not.toContainText('failed');
    // Rendering fixture only: recovery homes themselves still cannot start.
  } finally { await stopDedicatedServer(page, dedicated); }
});
