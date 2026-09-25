import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('chat transcript survives refresh and New chat starts an isolated conversation', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
    await page.locator('.agent-panel__input').fill('Hello conversation one');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-agent').last()).toBeVisible();
    const firstId = await page.evaluate(() => localStorage.getItem('u2os.conversationId'));
    expect(firstId).toMatch(/^conv_/);

    await page.reload();
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Hello conversation one');
    await expect(page.locator('.chat-bubble.is-agent').last()).toBeVisible();
    await page.locator('.agent-panel__new-chat').click();
    await expect(page.locator('.chat-bubble')).toHaveCount(0);
    await page.locator('.agent-panel__input').fill('Hello conversation two');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-agent').last()).toBeVisible();
    const secondId = await page.evaluate(() => localStorage.getItem('u2os.conversationId'));
    expect(secondId).not.toBe(firstId);
    await page.reload();
    await expect(page.locator('.chat-bubble.is-user')).toHaveCount(1);
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Hello conversation two');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
