import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const REQUEST = 'Move my 2 PM meeting with Sarah to tomorrow afternoon.';

test('owner can inspect why before approval and after the action completes', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    await page.locator('.agent-panel__input').fill(REQUEST);
    await page.locator('.agent-panel__composer button[type="submit"]').click();

    const card = page.locator('.approval-list u2-approval').last();
    await expect(card).toHaveAttribute('data-status', 'pending');
    await card.locator('u2-why summary').click();
    await expect(card.locator('u2-why')).toContainText('Proposing to move it');
    await expect(card.locator('u2-why')).toContainText('calendar.reschedule.default:confirm');
    await expect(card.locator('u2-why')).toContainText('mock-model-provider');
    await expect(card.locator('u2-why').getByRole('heading', { name: 'Source trail' })).toBeVisible();

    // The explanation contains labeled summaries and references, not an
    // executable/raw-HTML surface or a chain-of-thought field.
    await expect(card.locator('u2-why pre, u2-why script, u2-why iframe')).toHaveCount(0);
    await expect(card.locator('u2-why')).not.toContainText('chain_of_thought');

    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveAttribute('data-status', 'executed');
    await expect(card.locator('u2-why summary')).toBeVisible();
    await card.locator('u2-why summary').click();
    await expect(card.locator('u2-why')).toContainText('Agent action completed');

    await page.locator('u2-nav a[data-route="#/activity"]').click();
    const completed = page.locator('.u2-timeline__item', { hasText: 'Finished an action' }).first();
    await completed.locator('u2-why summary').click();
    await expect(completed.locator('u2-why')).toContainText('Proposing to move it');
  } finally {
    await stopDedicatedServer(page, dedicated);
  }
});
