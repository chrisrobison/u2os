import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

function writePackage(root) {
  const files = {
    'u2os.yaml': {
      apiVersion: 'u2os/v1', kind: 'Package',
      metadata: { id: 'com.example.pinger', name: 'Pinger', version: '0.1.0', description: 'Pings on request.' },
      exports: { capabilities: [{ id: 'pinger.ping', file: 'ping.yaml' }], automations: [{ id: 'pinger', file: 'pinger.yaml' }] },
      permissions: { network: true },
      policies: { pingFreely: { approval: 'automatic', description: 'Ping without asking' } },
    },
    'ping.yaml': { id: 'pinger.ping', effect: 'read', permissions: ['network'], implementation: { type: 'static', output: { pong: true } } },
    'pinger.yaml': { id: 'pinger', name: 'Pinger', triggers: [{ type: 'manual' }], steps: [{ id: 'ping', use: 'capability:pinger.ping', policy: 'pingFreely' }] },
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), yaml.dump(content));
  return root;
}

test('owner reviews, installs, grants, enables and runs a package automation', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const source = writePackage(fs.mkdtempSync(path.join(dedicated._dataDir, 'src-')));
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/packages`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Packages' })).toBeVisible();
    await expect(page.locator('u2-packages')).toContainText('No packages installed.');

    await page.locator('[data-review-package] [name="source"]').fill(source);
    await page.locator('[data-review-package] button[type="submit"]').click();
    const review = page.locator('.package-review');
    await expect(review).toContainText('Pinger wants permission to:');
    await expect(review).toContainText('access the network');
    await expect(review).toContainText('✓ Ping without asking');

    await review.locator('[data-install="none"]').click();
    await expect(page.locator('.trigger-message')).toContainText('Installed Pinger');
    const pkg = page.locator('[data-package-id="com.example.pinger"]');
    await expect(pkg).toContainText('· access the network');

    const automation = page.locator('[data-automation-id="pinger"]');
    await automation.locator('[data-automation-op="enable"]').click();
    await expect(page.locator('.trigger-message')).toContainText('Grant com.example.pinger these permissions');

    await pkg.locator('[data-grant-all]').click();
    await expect(pkg).toContainText('✓ access the network');
    await automation.locator('[data-automation-op="enable"]').click();
    await expect(automation.locator('.trigger-state')).toHaveText('Enabled');

    await automation.locator('[data-automation-run]').click();
    await expect(page.locator('.trigger-message')).toContainText('Run started');
    await expect(async () => {
      await page.locator('u2-nav a[data-route="#/operations"]').click();
      await page.locator('u2-nav a[data-route="#/packages"]').click();
      await page.locator('[data-automation-id="pinger"] [data-automation-history]').click();
      await expect(page.locator('[data-automation-id="pinger"] .trigger-history__status').first()).toHaveText('completed', { timeout: 1000 });
    }).toPass();
    await page.locator('[data-automation-id="pinger"] [data-run-detail]').first().click();
    await expect(page.locator('.package-steps')).toContainText('ping: completed · policy pingFreely → automatic');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
