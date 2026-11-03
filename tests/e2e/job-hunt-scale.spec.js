import { test, expect } from '@playwright/test';
import { startSeededServer, signInState, openPage, ready, noPageScroll, viewHash } from './job-hunt-e2e-helpers.js';

// #653: the Job Hunt views stay responsive with a large store. The real server is seeded through the hunt store with 5,000
// extra scored jobs; the checks are about what the owner waits for (a table page, a sort, a search, the Overview) and about
// how much the browser has to draw, with generous budgets so a slow CI machine does not fail them.

const JOBS = 5000;
const TOTAL = JOBS + 12; // plus the 8 board jobs and the 4 scenario jobs of the seed

test.describe('job hunt with a large store (#653)', () => {
  let server;
  let state;
  test.beforeAll(async ({ browser }) => {
    server = await startSeededServer({ filler: JOBS });
    state = await signInState(browser, server.baseURL);
  });
  test.afterAll(async () => { await server?.stop(); });

  /** Total time the main thread spent in tasks over 50 ms while `run` ran (Chromium only; null elsewhere). */
  async function blocked(page, run) {
    const supported = await page.evaluate(() => (window.__blocked = 0, PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false));
    if (!supported) { await run(); return null; }
    await page.evaluate(() => { window.__blocked = 0; new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__blocked += entry.duration; }).observe({ entryTypes: ['longtask'] }); });
    await run();
    await page.waitForTimeout(100);
    return page.evaluate(() => window.__blocked);
  }

  test('the Opportunities table draws one page of a 5,000-job store, and a sort, a search and a page change each settle quickly with one request', async ({ browser }) => {
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: viewHash(server.ids).opportunities, width: 1280 });
    try {
      const started = Date.now();
      await ready(page, 'opportunities');
      expect(Date.now() - started, 'first table').toBeLessThan(5000);
      await expect(page.locator('[data-part="range"]')).toContainText(`of ${TOTAL.toLocaleString('en-US')}`);
      expect(await page.locator('tr[data-job]').count(), 'one page of rows, never the whole store').toBeLessThanOrEqual(25);
      expect(await page.locator('body *').count(), 'DOM size').toBeLessThan(6000);

      const requests = [];
      page.on('request', (request) => { if (request.method() === 'GET' && request.url().includes('/api/job-hunt/opportunities?')) requests.push(request.url()); });
      const longest = await blocked(page, async () => {
        let t = Date.now();
        await page.locator('button[data-sort="company"]').click();
        await expect(page.locator('tr[data-job]').first().locator('[data-part="company"]')).toHaveText(/^A|^B|^C|^F|^G|^H|^I|^N|^S|^W/);
        expect(Date.now() - t, 'sort').toBeLessThan(3000);
        t = Date.now();
        await page.locator('[data-part="search"]').pressSequentially('Filler Company 49', { delay: 15 });
        await expect(page.locator('[data-part="range"]')).toContainText('of 199', { timeout: 5000 }); // the jobs whose name or role mentions 49 (the same count as the API)
        expect(Date.now() - t, 'search').toBeLessThan(4000);
        t = Date.now();
        await page.locator('[data-page="next"]').click();
        await expect(page.locator('[data-part="page"]')).toContainText('Page 2');
        expect(Date.now() - t, 'page change').toBeLessThan(3000);
      });
      // 1 request for the sort, 1 for the settled search (typing debounces), 1 for the page.
      expect(requests.length, requests.join('\n')).toBe(3);
      if (longest != null) expect(longest, 'main thread blocked by long tasks').toBeLessThan(1500);
      expect(await noPageScroll(page)).toBe(true);
    } finally { await context.close(); }
  });

  test('the Overview, with the board, loads and refreshes without drawing thousands of nodes', async ({ browser }) => {
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: '#/job-hunt', width: 1280 });
    try {
      const started = Date.now();
      await ready(page, 'overview');
      expect(Date.now() - started, 'first Overview').toBeLessThan(6000);
      await expect(page.locator('jh-summary-card[data-metric="discovered"] .jh-summary-card__value')).toHaveText(TOTAL.toLocaleString('en-US'));
      expect(await page.locator('body *').count(), 'DOM size').toBeLessThan(6000);
      const longest = await blocked(page, async () => {
        const before = await page.evaluate(() => performance.now());
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.proposed' } })));
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => performance.now()) - before).toBeGreaterThan(700);
      });
      if (longest != null) expect(longest, 'main thread blocked by a refresh').toBeLessThan(1500);
    } finally { await context.close(); }
  });
});
