import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('owner previews and soft-deletes relationships and entities from memory', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    const sarah = await page.evaluate(async () => {
      const data = await (await fetch('/api/memory/entities?type=Person&query=Sarah')).json();
      return data.entities[0];
    });
    await page.goto(`${dedicated.baseURL}/#/memory/${encodeURIComponent(sarah.id)}`);
    await expect(page.locator('.workspace__title')).toContainText('Sarah');

    const relationshipButtons = page.getByRole('button', { name: 'Delete relationship' });
    const relationshipCount = await relationshipButtons.count();
    page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('audit history'); await dialog.accept(); });
    await relationshipButtons.first().click();
    await expect(relationshipButtons).toHaveCount(relationshipCount - 1);

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Impact:');
      expect(dialog.message()).toContain('linked records');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete Person' }).click();
    await expect(page).toHaveURL(/#\/memory$/);
    await expect(page.locator('.entity-row', { hasText: 'Sarah' })).toHaveCount(0);
  } finally { await context.close(); await stopDedicatedServer(null, dedicated); }
});
