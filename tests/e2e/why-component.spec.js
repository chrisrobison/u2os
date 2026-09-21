import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test.describe('safe action explanation component (#30)', () => {
  let dedicated;

  test.beforeEach(async ({ page }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await stopDedicatedServer(page, dedicated);
  });

  test('loads lazily and renders every available section as inert text', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/actions/action-safe/explain', async (route) => {
      requests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'action-safe',
          reasoningSummary: 'Reply today <img src=x onerror="window.__unsafe = true">',
          model: 'local-qwen',
          policyDomain: 'email',
          policyRule: 'Sending email requires approval',
          contextProvenance: [{ type: 'email', id: 'email_123' }, { type: 'commitment', id: 'rel_456' }],
          relatedEvents: [{ id: 'evt_789', type: 'email.received', timestamp: '2026-09-20T12:00:00.000Z' }],
        }),
      });
    });

    await page.evaluate(async () => {
      await import('/components/u2-why.js');
      const why = document.createElement('u2-why');
      why.id = 'action-explanation-probe';
      why.setAttribute('action-id', 'action-safe');
      document.querySelector('#workspace').appendChild(why);
    });

    const why = page.locator('#action-explanation-probe');
    await expect(why.locator('summary')).toHaveText('Why?');
    expect(requests).toBe(0);

    await why.locator('summary').click();
    await expect(why.getByRole('heading', { name: 'What it noticed' })).toBeVisible();
    await expect(why).toContainText('Email email_123');
    await expect(why.getByRole('heading', { name: 'Decision' })).toBeVisible();
    await expect(why).toContainText('Reply today <img src=x onerror="window.__unsafe = true">');
    await expect(why).toContainText('Sending email requires approval');
    await expect(why).toContainText('local-qwen');
    await expect(why.getByRole('heading', { name: 'Source trail' })).toBeVisible();
    expect(requests).toBe(1);
    await expect(why.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();

    await why.locator('summary').click();
    await why.locator('summary').click();
    expect(requests).toBe(1);
  });

  test('shows an owner-readable error when the explanation cannot load', async ({ page }) => {
    await page.route('**/api/actions/missing/explain', (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Not Found' }),
    }));
    await page.evaluate(async () => {
      await import('/components/u2-why.js');
      const why = document.createElement('u2-why');
      why.id = 'missing-explanation-probe';
      why.actionId = 'missing';
      document.querySelector('#workspace').appendChild(why);
    });

    const why = page.locator('#missing-explanation-probe');
    await why.locator('summary').click();
    await expect(why.locator('.load-error')).toHaveText("Couldn't load explanation: Not Found");
  });
});
