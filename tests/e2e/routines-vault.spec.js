import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('owner sees routines, runs one, and reviews vault status, tool servers and the journal', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const vault = path.join(dedicated._dataDir, 'vault');
  fs.writeFileSync(path.join(vault, 'routines', 'plants.md'), '---\nname: Water the plants\nwhen:\n  daily: "08:00"\n---\nRemind me to water the plants.\n');
  fs.writeFileSync(path.join(vault, 'routines', 'broken.md'), '---\nwhen:\n  every_minutes: 1\n---\nToo often.\n');
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${dedicated.baseURL}/#/routines`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Routines' })).toBeVisible();

    const broken = page.locator('.routine-row', { hasText: 'routines/broken.md' });
    await expect(broken).toContainText('Needs fixing');
    await expect(broken.locator('.routine-row__error')).toContainText('every_minutes must be a whole number of at least 15');
    await expect(broken.locator('[data-run-routine]')).toBeDisabled();

    const plants = page.locator('.routine-row', { hasText: 'Water the plants' });
    await expect(plants).toContainText('daily at 08:00');
    await expect(plants.locator('[data-last-run]')).toHaveText('Last run: Never run');
    await plants.locator('[data-run-routine]').click();
    await expect(page.locator('.trigger-message')).toContainText('Done.');
    await expect(plants.locator('[data-last-run]')).toContainText('Completed · run by you');

    await page.locator('u2-nav a[data-route="#/vault"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Vault' })).toBeVisible();
    await expect(page.locator('[data-vault-policy]')).toContainText('Not present');
    await expect(page.locator('[data-vault-mcp]')).toContainText('No tool servers');
    const journal = page.locator('[data-journal]');
    await expect(journal.locator('[data-journal-type="routine.completed"]').first()).toContainText('Finished a routine');
    await expect(journal.locator('[data-journal-type="routine.fired"]').first()).toContainText('routine: routines/plants.md');

    fs.writeFileSync(path.join(vault, 'mcp.yaml'), 'servers:\n  broken:\n    command: /nonexistent/u2os-mcp-server\n    tools: { lookup: { read: true } }\n');
    await page.locator('[data-vault-action="restart-mcp"]').click();
    await expect(page.locator('.trigger-message')).toContainText('0 of 1 tool server running.');
    await expect(page.locator('[data-mcp-server="broken"]')).toContainText('Failed');

    fs.writeFileSync(path.join(vault, 'policies.yaml'), 'email: [not, valid]\n');
    await page.locator('[data-vault-action="reindex"]').click();
    await expect(page.locator('[data-vault-policy]')).toContainText('Until it is fixed, U2OS asks before every action');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
