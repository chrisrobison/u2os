import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('conversation and document cards render structured text without interpreting markup', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, 'correct horse battery staple');
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.evaluate(() => {
      const dashboard = document.createElement('u2-dashboard'); dashboard.id = 'structured-probe';
      dashboard.schema = { title: 'Structured cards', layout: 'dashboard', components: [
        { type: 'conversation', data: { thread: 'Jamie <img src=x onerror=alert(1)>', messages: [{ sender: 'Jamie', text: '<script>bad()</script>' }], summary: 'Follow-up', unresolvedQuestion: 'When?', nextStep: 'Reply' } },
        { type: 'document', data: { title: 'Budget <script>bad()</script>', type: 'PDF', source: 'local', excerpt: '<img src=x>', whyRelevant: 'Meeting tomorrow' } },
      ] };
      document.body.append(dashboard);
    });
    const probe = page.locator('#structured-probe');
    await expect(probe.locator('u2-conversation')).toContainText('<script>bad()</script>');
    await expect(probe.locator('u2-document')).toContainText('<img src=x>');
    await expect(probe.locator('script, img')).toHaveCount(0);
  } finally { await context.close(); await stopDedicatedServer(null, dedicated); }
});
