import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const PROMPT = "What's going on today? Handle anything routine that doesn't need me and tell me what I need to pay attention to.";

test('daily-driver story runs through the real browser, approval, explanation, and memory UI', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();

    await page.locator('.agent-panel__input').fill(PROMPT);
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-agent').last()).toContainText('northwindtalent.example');

    // The live dashboard now mirrors newly proposed actions in its own
    // approval card. This story deliberately drives the agent transcript,
    // so keep the locator scoped to that panel instead of matching both
    // legitimate presentations of the same action.
    const cards = page.locator('u2-agent .approval-list u2-approval');
    await expect(cards).toHaveCount(2);
    const automatic = cards.filter({ hasText: 'send a notification' });
    await expect(automatic).toHaveAttribute('data-status', 'executed');
    await expect(automatic.locator('[data-action="approve"]')).toHaveCount(0);

    const email = cards.filter({ hasText: 'send an email' });
    await expect(email).toHaveAttribute('data-status', 'pending');
    await email.locator('u2-why summary').click();
    await expect(email.locator('.u2-why__panel')).toContainText('email.send:fallback-confirm');
    await expect(email.locator('.u2-why__panel')).toContainText('Event');
    await email.locator('[data-action="approve"]').click();
    await expect(email).toHaveAttribute('data-status', 'executed');
    await expect(page.locator('.chat-bubble.is-system').last()).toHaveText('Done. Sent.');
    await expect(page.locator('u2-agent-status .status-pill')).toHaveAttribute('data-state', 'idle');

    await page.locator('u2-nav a[data-route="#/memory"]').click();
    const candidate = page.locator('form.dashboard-card', { hasText: 'follow-up conversation this week' });
    await expect(candidate).toBeVisible();
    await candidate.locator('select[name="entityId"]').selectOption({ label: 'Jamie Alvarez' });
    await candidate.locator('input[name="key"]').fill('follow_up_request');
    await candidate.locator('button[type="submit"]').click();
    await expect(candidate).toHaveCount(0);

    await page.locator('.agent-panel__input').fill('What do you remember about Jamie?');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-agent').last()).toContainText('wants to schedule a follow-up conversation this week');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
