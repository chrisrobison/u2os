import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('personal connector status shows unavailable services without offering mock selection', async ({ browser }) => {
  const dedicated = await startDedicatedServer({ mode: 'personal' });
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${dedicated.baseURL}/#/connectors`);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.agent-panel__notice')).toContainText('Planner unavailable');
    await expect(page.locator('.agent-panel__input')).toBeDisabled();
    const email = page.locator('u2-card[title="Email"]');
    await expect(email).toContainText('No real account selected');
    await expect(email.locator('.status-dot')).toHaveClass(/is-disconnected/);
    await expect(email.locator('select option[value="mock"]')).toBeDisabled();
    await page.goto(`${dedicated.baseURL}/#/mail`);
    await expect(page.locator('.workspace__title', { hasText: 'Mail' })).toBeVisible();
    await expect(page.locator('.connector-meta', { hasText: 'Local cached records' })).toBeVisible();
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
