import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDedicatedServer, stopDedicatedServer, createOwner, gotoNav } from './helpers.js';

const passphrase = 'fixture-only add-ons page owner';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'addon-fake-server.js');
const MANIFEST = `apiVersion: u2os/v1
kind: Addon
metadata: { id: demo, name: Demo mail, version: 0.2.0, description: A test add-on., author: Tester }
servers:
  demo:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(FAKE)}]
    tools:
      mail_unread: { tool: mail, fixed: { operation: unread }, read: true, classification: personal, description: Read unread mail. }
      mail_send: { tool: mail, fixed: { operation: send }, description: Send mail. }
settings:
  limit: { type: number, default: 5, description: Rows to fetch }
ui:
  nav: [{ id: demo, title: Demo mail, icon: envelope, group: Add-ons }]
`;

test('owner browses, enables and confirms an add-on; its navigation entry appears and goes away', async ({ page }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  try {
    fs.mkdirSync(path.join(dedicated._dataDir, 'addons', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dedicated._dataDir, 'addons', 'demo', 'addon.yaml'), MANIFEST);
    fs.writeFileSync(path.join(dedicated._dataDir, 'addons', 'demo', 'README.md'), 'Reads and sends mail for tests.');
    await createOwner(dedicated.baseURL, passphrase); await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill(passphrase); await page.locator('form button[type="submit"]').click();
    await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
    await gotoNav(page, '#/addons');

    const card = page.locator('u2-addons [data-addon="demo"]');
    await expect(card).toContainText('Demo mail 0.2.0');
    await expect(card).toContainText('Not enabled');
    await expect(card).toContainText('Installed (third party)');
    await expect(page.locator('nav a[data-route="#/addons/demo"], u2-nav a[data-route="#/addons/demo"]')).toHaveCount(0);

    await card.getByRole('button', { name: 'Details' }).click();
    await expect(card).toContainText('Reads and sends mail for tests.');
    const unread = card.locator('[data-tool="demo.mail_unread"]');
    await expect(unread).toContainText('Not confirmed yet: asks before acting, results treated as private.');
    await expect(unread).toContainText('Suggested by the add-on: read-only, personal results.');

    await card.getByRole('button', { name: 'Enable' }).click();
    await expect(page.locator('.addons-status')).toContainText('Demo mail enabled.');
    await expect(card).toContainText('Tool server demo: running');
    await expect(page.locator('u2-nav a[data-route="#/addons/demo"]')).toHaveCount(1);

    await unread.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('.addons-status')).toContainText('demo.mail_unread confirmed.');
    await expect(unread).toContainText('Your decision: read-only, personal results.');
    await expect(card.locator('[data-tool="demo.mail_send"]')).toContainText('Not confirmed yet');

    await card.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('.addons-status')).toContainText('Settings saved.');

    // decisions are in the vault file and survive a reload
    expect(fs.readFileSync(path.join(dedicated._dataDir, 'vault', 'addons.yaml'), 'utf8')).toMatch(/enabled: true/);
    await page.reload();
    await expect(page.locator('u2-addons [data-addon="demo"]')).toContainText('Enabled');
    await page.locator('u2-nav a[data-route="#/addons/demo"]').click();
    await expect(page.locator('u2-addons [data-addon="demo"] [data-tool="demo.mail_unread"]')).toContainText('Your decision: read-only');

    await page.locator('u2-addons [data-addon="demo"]').getByRole('button', { name: 'Disable' }).click();
    await expect(page.locator('.addons-status')).toContainText('Demo mail disabled.');
    await expect(page.locator('u2-nav a[data-route="#/addons/demo"]')).toHaveCount(0);
  } finally { await stopDedicatedServer(page, dedicated); }
});
