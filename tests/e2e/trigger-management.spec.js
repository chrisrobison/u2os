import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('owner creates, pauses, resumes, and deletes a structured automation', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${dedicated.baseURL}/#/automation`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Automation' })).toBeVisible();

    const form = page.locator('[data-create-trigger]');
    await form.locator('[name="name"]').fill('Review the alpha checklist');
    await form.locator('[name="kind"]').selectOption('schedule');
    await expect(form.locator('[data-schedule-field]')).toBeVisible();
    await form.locator('[name="everyMinutes"]').fill('30');
    await form.locator('button[type="submit"]').press('Enter');

    await expect(page.locator('.trigger-message')).toHaveText('Automation created.');
    const row = page.locator('.trigger-row', { hasText: 'Review the alpha checklist' });
    await expect(row).toContainText('Runs every 30 minutes');
    await expect(row).toContainText('Enabled');
    await expect(row.locator('[data-delete-trigger]')).toBeVisible();

    await row.locator('[data-trigger-history]').click();
    await expect(row.locator('[data-trigger-history]')).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('.trigger-history')).toContainText('No runs yet.');
    const missingHistory = await page.request.get(`${dedicated.baseURL}/api/triggers/missing/history`);
    expect(missingHistory.status()).toBe(404);

    await row.locator('[data-trigger-dry-run]').click();
    await expect(page.locator('.trigger-message')).toHaveText('Dry run complete. No actions were executed.');
    await expect(row.locator('.trigger-preview')).toContainText('Would run now: No');
    await expect(row.locator('.trigger-preview')).toContainText('No side effects');

    await row.locator('[data-toggle-trigger]').press('Enter');
    await expect(row).toContainText('Paused');
    await row.locator('[data-toggle-trigger]').press('Enter');
    await expect(row).toContainText('Enabled');

    page.once('dialog', (dialog) => dialog.accept());
    await row.locator('[data-delete-trigger]').click();
    await expect(page.locator('.trigger-message')).toHaveText('Automation deleted.');
    await expect(row).toHaveCount(0);
    await expect(page.locator('.trigger-row')).toHaveCount(3);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
