import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// #436: a message opens in the shared dialog and offers a reply link.
// Seeded inbox mail (server/seed/seed.js) uses the mock provider, so the
// reply is a mailto link; the Gmail link shape is covered by unit tests.
const PASSPHRASE = 'correct horse battery staple';

test.describe.serial('mail view and reply (#436)', () => {
  let dedicated;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    await page.goto(`${dedicated.baseURL}/#/mail`);
    await expect(page.locator('.u2-email__subject', { hasText: 'Standup notes' })).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  test('selecting a message opens it with its details and a reply link', async () => {
    await page.locator('button.u2-email--select', { hasText: 'Standup notes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Message' });
    await expect(dialog.getByLabel('From')).toHaveValue(/marcus\.lee@example\.com/);
    await expect(dialog.getByLabel('Subject')).toHaveValue('Standup notes');
    await expect(dialog.getByLabel('Message')).not.toHaveValue('');

    const reply = dialog.getByRole('link', { name: 'Reply' });
    const href = await reply.getAttribute('href');
    expect(href.startsWith('mailto:marcus.lee@example.com?subject=Re%3A%20Standup%20notes')).toBe(true);
    expect(decodeURIComponent(href)).toContain('wrote:');
    await expect(reply).toHaveAttribute('target', '_blank');
    await expect(reply).toHaveAttribute('rel', 'noopener noreferrer');

    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('button.u2-email--select', { hasText: 'Standup notes' })).toBeFocused();
  });

  test('the message fields are read-only and nothing is sent or changed', async () => {
    await page.locator('button.u2-email--select', { hasText: 'Standup notes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Message' });
    await expect(dialog.getByLabel('Subject')).not.toBeEditable();
    await expect(dialog.getByRole('button', { name: /send|delete|spam/i })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  test('dashboard mail summaries stay read-only', async () => {
    await page.goto(`${dedicated.baseURL}/#/home`);
    await expect(page.locator('u2-card u2-email-summary').first()).toBeVisible();
    await expect(page.locator('button.u2-email--select')).toHaveCount(0);
  });

  test('a message that cannot be opened says so', async () => {
    await page.goto(`${dedicated.baseURL}/#/mail`);
    await expect(page.locator('button.u2-email--select').first()).toBeVisible();
    await page.route('**/api/email/*', (route) => route.fulfill({ status: 404, json: { error: 'No such message' } }));
    await page.locator('button.u2-email--select', { hasText: 'Standup notes' }).click();
    await expect(page.getByRole('dialog', { name: 'Message' })).toContainText("Couldn't open this message");
  });
});
