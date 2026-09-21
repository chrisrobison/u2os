import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('owner diagnostics is readable, redacted, responsive, and refreshes from live events', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  let requests = 0;
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    await page.route('**/api/diagnostics', async (route) => {
      requests += 1;
      await route.fulfill({ json: fixture(requests > 1 ? 2 : 1) });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.locator('u2-nav a[data-route="#/diagnostics"]').click();

    const view = page.locator('u2-diagnostics');
    await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
    await expect(view.getByRole('status')).toHaveText('System degraded');
    await expect(view).toContainText('Dead letters');
    await expect(view).toContainText('mailunavailable · mock');
    await expect(view).not.toContainText('PRIVATE EMAIL BODY');
    await expect(view).not.toContainText('secret-idempotency-key');

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.completed' } })));
    await expect(view).toContainText('Completed2');
    expect(requests).toBeGreaterThan(1);
  } finally {
    await stopDedicatedServer(page, dedicated);
  }
});

function fixture(completed) {
  return {
    status: 'degraded',
    server: { uptimeSeconds: 65, sseClientCount: 1 },
    database: { state: 'healthy', sizeBytes: 2048, eventCount: 12 },
    actions: { pendingApproval: 1, queued: 0, retrying: 0, failed: 0, deadLetters: 1, completed },
    memory: { entities: 4, facts: 8 },
    model: { state: 'degraded', provider: 'mock-planner', mode: 'mock' },
    embeddings: { state: 'unavailable', provider: null },
    connectors: [{ domain: 'mail', provider: 'mock', state: 'unavailable', mode: 'mock', lastSuccessfulSync: null }],
    recentErrors: [{ timestamp: '2026-09-20T12:00:00.000Z', level: 'error', component: 'action-queue', message: 'An error was reported' }],
    private: 'PRIVATE EMAIL BODY secret-idempotency-key',
  };
}
