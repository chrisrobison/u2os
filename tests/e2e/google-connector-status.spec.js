import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('Google connection dots reflect stored connections even when mock providers are active', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const domains = ['calendar', 'email', 'contacts', 'web', 'notifications'];
    await page.route('**/api/connectors', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connectors: domains.map((domain) => ({
            domain,
            active: 'mock',
            connected: true,
            connectedProviders:
              domain === 'email' ? ['gmail'] : domain === 'contacts' ? ['google-contacts'] : [],
            availableProviders: ['mock'],
            manifests: [],
            lastSyncAt: null,
            lastError: null,
          })),
          smtpConfigured: false,
        }),
      });
    });

    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    const google = page.locator('u2-card[title="Google"]');
    const gmail = google.locator('.connector-google-row', { hasText: 'Gmail' });
    const contacts = google.locator('.connector-google-row', { hasText: 'Contacts' });
    const calendar = google.locator('.connector-google-row', { hasText: 'Calendar' });

    await expect(gmail.locator('.status-dot')).toHaveClass(/is-connected/);
    await expect(gmail.locator('button')).toHaveText('Disconnect');
    await expect(contacts.locator('.status-dot')).toHaveClass(/is-connected/);
    await expect(contacts.locator('button')).toHaveText('Disconnect');
    await expect(calendar.locator('.status-dot')).toHaveClass(/is-disconnected/);
    await expect(calendar.locator('button')).toHaveText('Connect');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
