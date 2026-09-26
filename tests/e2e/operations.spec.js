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

test.describe('original account and uncertain delivery metadata', () => {
  let dedicated;
  test.beforeEach(async ({ page }) => {
    dedicated = await startDedicatedServer({ mode: 'personal' });
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.goto(dedicated.baseURL); await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
  });
  test.afterEach(async ({ page }) => { await stopDedicatedServer(page, dedicated); });

  test('uncertain send shows original account/SMTP identity as inert text, without private payloads or retry controls', async ({ page }) => {
    const label = 'Original <img src=x onerror="window.__operationUnsafe=true"> account';
    await page.route('**/api/actions/operations', (route) => route.fulfill({ json: {
      items: [{ id: 'fixture-uncertain', actionId: 'fixture-action', tool: 'email.send', status: 'failed', attemptCount: 1,
        errorClass: 'outcome_uncertain', account: { label, providerId: 'imap', instanceId: 'fixture-original-inbox',
          smtpIdentity: { label: 'Original SMTP fixture', instanceId: 'fixture-original-sender', from: 'owner@example.test', password: 'fixture-private-password' },
          access_token: 'fixture-private-token' }, arguments: { body: 'fixture-private-body' }, last_error: 'fixture-private-upstream-error' }], counts: { failed: 1 },
    } }));
    await page.locator('u2-nav a[data-route="#/operations"]').click();
    const card = page.locator('u2-operations .operation-card').first();
    await expect(card.locator('.operation-card__meta')).toHaveText('outcome uncertain · 1 attempt');
    await expect(card).toContainText(`Original account: ${label} (imap; fixture-original-inbox)`);
    await expect(card).toContainText('SMTP sender: Original SMTP fixture (fixture-original-sender; owner@example.test)');
    await expect(card).toContainText('Check the original account/provider'); await expect(card).toContainText('No automatic retry or requeue');
    await expect(card).not.toContainText('fixture-private'); await expect(card.locator('img, script, button, a')).toHaveCount(0);
    expect(await page.evaluate(() => window.__operationUnsafe)).toBeUndefined();
  });

  test('ordinary failure, missing uncertain identity and explicit mock account remain distinct', async ({ page }) => {
    await page.route('**/api/actions/operations', (route) => route.fulfill({ json: {
      items: [
        { id: 'fixture-known', tool: 'tasks.create', status: 'failed', attemptCount: 1, errorClass: 'non_retryable' },
        { id: 'fixture-unknown', tool: 'email.send', status: 'failed', attemptCount: 1, errorClass: 'outcome_uncertain', account: null },
        { id: 'fixture-mock', tool: 'email.send', status: 'completed', attemptCount: 1, account: { label: 'Mock', providerId: 'mock', instanceId: null } },
      ], counts: { failed: 2, completed: 1 },
    } }));
    await page.locator('u2-nav a[data-route="#/operations"]').click();
    const known = page.locator('u2-operations .operation-card').filter({ hasText: 'tasks.create' });
    await expect(known.locator('.operation-card__meta')).toHaveText('failed · 1 attempt'); await expect(known).toContainText('non retryable');
    const uncertain = page.locator('u2-operations [data-outcome="uncertain"]');
    await expect(uncertain).toContainText('Original account unavailable'); await expect(uncertain).toContainText('inspect the original action');
    await expect(uncertain.locator('.operation-card__meta')).not.toContainText('failed');
    const mock = page.locator('u2-operations .operation-card[data-status="completed"]');
    await expect(mock).toContainText('Original account: Mock (mock; no account instance)');
    await expect(page.locator('u2-operations [data-status="failed"].operations-count')).toHaveText('Needs attention: 2');
  });

  test('long original identity remains readable on a narrow viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const label = 'Original_' + 'fixture'.repeat(20), instanceId = 'fixture_' + 'identity'.repeat(20);
    await page.route('**/api/actions/operations', (route) => route.fulfill({ json: {
      items: [{ id: 'fixture-narrow', tool: 'email.send', status: 'failed', attemptCount: 1, errorClass: 'outcome_uncertain',
        account: { label, providerId: 'gmail', instanceId } }], counts: { failed: 1 },
    } }));
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await page.locator('u2-nav a[data-route="#/operations"]').click();
    const card = page.locator('u2-operations .operation-card'); await expect(card).toContainText(label); await expect(card).toContainText(instanceId);
    const bounds = await card.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
    await expect(card).toContainText('No automatic retry or requeue');
  });
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
