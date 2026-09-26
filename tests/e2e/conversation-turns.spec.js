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
    const picker = page.locator('.agent-panel__conversations');
    await expect(picker.locator('option')).toHaveCount(3);
    await picker.selectOption(firstId);
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Hello conversation one');
    expect(await page.evaluate(() => localStorage.getItem('u2os.conversationId'))).toBe(firstId);
    await page.locator('.agent-panel__input').fill('Follow up in first chat');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-agent').last()).toBeVisible();
    await picker.selectOption(secondId);
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Hello conversation two');
    await page.route(`**/api/agent/conversations/${firstId}/turns`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
    await picker.selectOption(firstId);
    await expect(page.locator('.agent-panel__notice')).toContainText('unavailable');
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Hello conversation two');
    expect(await page.evaluate(() => localStorage.getItem('u2os.conversationId'))).toBe(secondId);
    await page.unroute(`**/api/agent/conversations/${firstId}/turns`);
    let releaseReply;
    let requestStarted;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    await page.route('**/api/agent/message', async (route) => {
      requestStarted();
      await new Promise((resolve) => { releaseReply = resolve; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: 'Stale reply', actions: [] }) });
    });
    await page.locator('.agent-panel__input').fill('Slow request in second chat');
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await started;
    await picker.selectOption(firstId);
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText('Follow up in first chat');
    const response = page.waitForResponse((res) => res.url().endsWith('/api/agent/message') && res.status() === 200);
    releaseReply();
    await response;
    await expect(page.locator('.chat-bubble', { hasText: 'Stale reply' })).toHaveCount(0);
    await picker.selectOption('');
    await expect(page.locator('.chat-bubble')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('u2os.conversationId'))).toBeNull();
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
