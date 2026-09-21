import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

test('morning dashboard adds a task from SSE without navigation or reload', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${dedicated.baseURL}/#/home`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-dashboard')).toBeVisible();

    const marker = await page.evaluate(() => {
      window.__dashboardDocumentMarker = crypto.randomUUID();
      return window.__dashboardDocumentMarker;
    });
    const title = `Live dashboard task ${Date.now()}`;
    await page.evaluate(async (taskTitle) => {
      const api = await import('/services/api.js');
      await api.createTask({ title: taskTitle });
    }, title);

    await expect(page.locator('u2-card[title="Tasks"] .u2-task__title', { hasText: title })).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    expect(await page.evaluate(() => window.__dashboardDocumentMarker)).toBe(marker);

    const refreshCount = await page.evaluate(async () => {
      const dashboard = document.querySelector('u2-dashboard');
      let calls = 0;
      dashboard.refreshLoader = async () => { calls += 1; return dashboard.schema; };
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'task.updated' } }));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      return calls;
    });
    expect(refreshCount).toBe(1);

    await page.evaluate(() => {
      const dashboard = document.querySelector('u2-dashboard');
      const pending = [];
      dashboard.refreshLoader = () => new Promise((resolve) => pending.push(resolve));
      window.__dashboardRefreshResolvers = pending;
      dashboard._refresh();
      dashboard._refresh();
    });
    await page.waitForFunction(() => window.__dashboardRefreshResolvers.length === 2);
    await page.evaluate(() => window.__dashboardRefreshResolvers[1]({ title: 'Newest dashboard', components: [] }));
    await expect(page.locator('u2-dashboard .workspace__title')).toHaveText('Newest dashboard');
    await page.evaluate(() => window.__dashboardRefreshResolvers[0]({ title: 'Stale dashboard', components: [] }));
    await expect(page.locator('u2-dashboard .workspace__title')).toHaveText('Newest dashboard');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
