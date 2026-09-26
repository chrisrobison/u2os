import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
for (const outcome of ['success', 'failure']) {
  test(`late Home/Briefing ${outcome} cannot replace selected Operations view`, async ({ page }) => {
    const dedicated = await startDedicatedServer(), release = deferred(), reached = deferred();
    try {
      await createOwner(dedicated.baseURL, 'fixture-only navigation owner'); await page.goto(dedicated.baseURL);
      await page.getByLabel('Passphrase').fill('fixture-only navigation owner'); await page.locator('form button[type="submit"]').click();
      await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
      await page.locator('u2-app').evaluate((app) => {
        const render = app._renderDashboard.bind(app);
        app._renderDashboard = (...args) => render(...args).finally(() => { window.fixtureLateDashboardSettled = true; });
      });
      await page.route('**/api/dashboard/morning', async (route) => {
        const actual = outcome === 'success' ? await route.fetch() : null;
        reached.resolve(); await release.promise;
        await route.fulfill(actual ? { response: actual } : { status: 503, json: { error: 'fixture-private-late-dashboard-error' } });
      });
      await page.locator('u2-nav a[data-route="#/briefing"]').click(); await reached.promise;
      await page.locator('u2-nav a[data-route="#/operations"]').click(); await expect(page.locator('u2-operations .operations-summary')).toBeVisible();
      release.resolve(); await expect.poll(() => page.evaluate(() => window.fixtureLateDashboardSettled)).toBe(true);
      await expect(page.locator('u2-operations')).toBeVisible(); await expect(page.locator('#workspace u2-dashboard, #workspace .workflow-start')).toHaveCount(0);
      await expect(page.locator('#workspace')).not.toContainText('fixture-private-late-dashboard-error');
    } finally { release.resolve(); await stopDedicatedServer(page, dedicated); }
  });
}
