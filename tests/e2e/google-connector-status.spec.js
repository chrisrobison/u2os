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
          catalog: { version: 1, connectors: [{ id: 'google', name: 'Google', description: 'Google services', status: 'available', capabilities: ['calendar', 'email', 'contacts'], setup: { type: 'oauth2', fields: [], services: [{ id: 'calendar', label: 'Calendar', providerId: 'google-calendar', domain: 'calendar' }, { id: 'gmail', label: 'Gmail', providerId: 'gmail', domain: 'email' }, { id: 'contacts', label: 'Contacts', providerId: 'google-contacts', domain: 'contacts' }] } }] },
        }),
      });
    });

    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    await page.locator('[data-catalog-id="google"]').click();
    const google = page.locator('u2-connector-setup dialog');
    const gmail = google.locator('.connector-service', { hasText: 'Gmail' });
    const contacts = google.locator('.connector-service', { hasText: 'Contacts' });
    const calendar = google.locator('.connector-service', { hasText: 'Calendar' });

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
