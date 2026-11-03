import { test, expect } from '@playwright/test';
import { startSeededServer, signInState, openPage, ready, viewHash } from './job-hunt-e2e-helpers.js';

// #653: the main Job Hunt journey across views against the REAL server (seeded through the hunt store, nothing stubbed):
// Overview -> Opportunities -> detail panel -> Notes -> Operations, by keyboard alone; the Overview cards agree with the
// table they open; one h1 per view; "Ask about this job" from the panel and the full page; unsaved notes survive leaving
// the view; a hidden tab stops polling and refreshes when it returns; and selecting rows makes no duplicate requests.
// The same file runs in Firefox and WebKit.

const nav = (page, hash) => page.locator(`u2-nav a[data-route="${hash}"]`);

/** Presses Tab (or Shift+Tab) until `locator` has focus; fails if it is not reached in `max` presses. */
async function tabTo(page, locator, { shift = false, max = 150 } = {}) {
  // Safari on macOS skips links with a plain Tab unless "Press Tab to highlight each item" is on; Option+Tab reaches everything.
  const key = `${shift ? 'Shift+' : ''}${page.context().browser().browserType().name() === 'webkit' && process.platform === 'darwin' ? 'Alt+' : ''}Tab`;
  for (let i = 0; i <= max; i += 1) {
    if (await locator.evaluate((node) => node === document.activeElement)) return i;
    await page.keyboard.press(key);
  }
  throw new Error(`${locator} was not reached with ${shift ? 'Shift+' : ''}Tab in ${max} presses`);
}

/** The focused element must show a focus indicator (an outline or a ring), not rely on the browser default being kept. */
async function expectFocusRing(locator, label) {
  const shown = await locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1.5) || (style.boxShadow !== 'none' && style.boxShadow !== '');
  });
  expect(shown, `${label} shows where focus is`).toBe(true);
}

test.describe('job hunt cross-view journey (#653)', () => {
  let server;
  let state;
  test.beforeAll(async ({ browser }) => {
    server = await startSeededServer();
    state = await signInState(browser, server.baseURL);
  });
  test.afterAll(async () => { await server?.stop(); });

  test('keyboard only: Overview, Opportunities, open a job, its Notes tab, Operations, with visible focus and focus returning to the row', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.overview, width: 1280 });
    try {
      await ready(page, 'overview');
      const note = `Keyboard journey ${Date.now()}`;

      // Overview -> Opportunities through the navigation links.
      const toOpportunities = nav(page, '#/job-hunt/opportunities');
      await tabTo(page, toOpportunities);
      await expectFocusRing(toOpportunities, 'the Opportunities nav link');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities$/);
      await ready(page, 'opportunities');

      // To the table's one tab stop, then open that job in the panel.
      const row = page.locator('tr[data-job][tabindex="0"]');
      await tabTo(page, row);
      await expectFocusRing(row, 'the table row');
      const jobId = await row.getAttribute('data-job');
      await page.keyboard.press('Enter');
      const panel = page.locator('u2-job-detail-panel');
      await expect(panel.locator('[data-part="heading"]')).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`job=${jobId}`));

      // Panel: the tab strip is one tab stop; End selects the last tab (Notes).
      const selectedTab = panel.getByRole('tab', { selected: true });
      await tabTo(page, selectedTab);
      await expectFocusRing(selectedTab, 'the selected tab');
      await page.keyboard.press('End');
      const notesTab = panel.getByRole('tab', { name: 'Notes' });
      await expect(notesTab).toBeFocused();
      await expect(notesTab).toHaveAttribute('aria-selected', 'true');
      const area = panel.locator('u2-job-notes textarea');
      await expect(area).toBeVisible();
      await tabTo(page, area);
      await expectFocusRing(area, 'the notes field');
      await page.keyboard.type(note);

      // Back to the tab strip (the field keeps its own Escape), then Escape closes the panel and focus returns to the row.
      await tabTo(page, notesTab, { shift: true });
      await page.keyboard.press('Escape');
      await expect(page).not.toHaveURL(/job=/);
      await expect(page.locator(`tr[data-job="${jobId}"]`)).toBeFocused();
      await expectFocusRing(page.locator(`tr[data-job="${jobId}"]`), 'the row focus returned to');

      // The note was saved to the vault on the way out.
      await expect.poll(async () => (await (await page.request.get(`${server.baseURL}/api/job-hunt/jobs/${jobId}/notes`)).json()).body).toContain(note);

      // Opportunities -> Operations through the navigation.
      const toOperations = nav(page, '#/job-hunt/operations');
      await tabTo(page, toOperations, { shift: true });
      await expectFocusRing(toOperations, 'the Agent Operations nav link');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#\/job-hunt\/operations$/);
      await ready(page, 'operations');
      await expect(page.locator('u2-job-operations h1')).toHaveText('Agent Operations');
    } finally { await context.close(); }
  });

  test('every view has exactly one h1, and the heading levels step down without skipping', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    for (const kind of ['overview', 'opportunities', 'panel', 'operations', 'page', 'readyPage']) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes[kind], width: 1280 });
      try {
        await ready(page, kind);
        const levels = await page.locator('#workspace :is(h1, h2, h3, h4, h5, h6)').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length).map((node) => Number(node.tagName[1])));
        expect(levels.filter((level) => level === 1), `${kind}: h1 count`).toHaveLength(1);
        expect(levels[0], `${kind}: the first heading is the h1`).toBe(1);
        for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1], `${kind}: heading levels ${levels.join('')}`).toBeLessThanOrEqual(1);
      } finally { await context.close(); }
    }
  });

  test('each Overview card opens a table with the number it shows; Submitted and Responded say plainly when the table lists fewer', async ({ browser }) => {
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: '#/job-hunt', width: 1280 });
    try {
      await ready(page, 'overview');
      const overview = await (await page.request.get(`${server.baseURL}/api/job-hunt/overview`)).json();
      const metric = Object.fromEntries(overview.metrics.map((entry) => [entry.id, entry]));
      // Seeded: 8 jobs were sent (6 still applied or beyond, 1 withdrawn, 1 closed since), so the table lists 6 of them.
      expect(metric.submitted.value).toBe(8);
      expect(metric.submitted.listed).toBe(6);
      for (const id of ['discovered', 'strong', 'attention', 'submitted', 'responded', 'interviewing']) {
        await page.goto(`${server.baseURL}/#/job-hunt`);
        await ready(page, 'overview');
        const card = page.locator(`jh-summary-card[data-metric="${id}"]`);
        const response = page.waitForResponse((r) => r.url().includes('/api/job-hunt/opportunities?') && r.request().method() === 'GET');
        await card.getByRole('link').click();
        const { total } = await (await response).json();
        const expected = metric[id].listed ?? metric[id].value;
        expect(total, `${id}: the table opened by the card`).toBe(expected);
        if (metric[id].listed != null && metric[id].listed !== metric[id].value) {
          await page.goto(`${server.baseURL}/#/job-hunt`);
          await expect(page.locator(`jh-summary-card[data-metric="${id}"] .jh-summary-card__sub`)).toContainText(`Table lists ${metric[id].listed} by current status`);
        } else {
          await page.goto(`${server.baseURL}/#/job-hunt`);
          await expect(page.locator(`jh-summary-card[data-metric="${id}"] .jh-summary-card__sub`)).not.toContainText('Table lists');
        }
      }
    } finally { await context.close(); }
  });

  test('Review on an attention item opens that job in the Opportunities panel, not the full page', async ({ browser }) => {
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: '#/job-hunt', width: 1280 });
    try {
      await ready(page, 'overview');
      const id = server.ids['needs-1'];
      const review = page.locator(`[data-job="${id}"] [data-part="review"]`);
      await expect(review).toHaveAttribute('href', `#/job-hunt/opportunities?job=${id}`);
      await review.click();
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/opportunities\\?job=${id}$`));
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toContainText('Senior Staff Platform Engineer');
      await expect(page.locator('tr[data-job]').first()).toBeVisible();
      // The panel's own link still reaches the full page, and the old question deep link still works there.
      await page.locator('u2-job-detail-panel [data-part="full-page"]').click();
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/jobs/${id}$`));
      await page.goto(`${server.baseURL}/#/job-hunt/jobs/${id}?question=custom%3Awhy`);
      await expect(page.locator('u2-job-page [data-key="custom:why"] :is(input, textarea, select)')).toBeFocused();
    } finally { await context.close(); }
  });

  test('"Ask about this job" attaches the job to the chat from the panel and from the full page', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    for (const [kind, button] of [['panel', 'u2-job-detail-panel [data-detail-action="ask"]'], ['page', 'u2-job-page [data-page-action="ask"]']]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes[kind], width: 1280 });
      try {
        await ready(page, kind);
        const chip = page.locator('u2-agent-context');
        await expect(chip).toBeHidden();
        const writes = [];
        page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url()); });
        await page.locator(button).click();
        await expect(chip).toBeVisible();
        await expect(chip).toContainText('Northern Lights Distributed Systems');
        expect(writes, 'asking sends nothing').toEqual([]);
      } finally { await context.close(); }
    }
  });

  test('unsaved notes are saved when the owner leaves the view with the panel still open', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.panel, width: 1280 });
    try {
      await ready(page, 'panel');
      const panel = page.locator('u2-job-detail-panel');
      await panel.getByRole('tab', { name: 'Notes' }).click();
      const note = `Left the view ${Date.now()}`;
      await panel.locator('u2-job-notes textarea').fill(note);
      await page.goto(`${server.baseURL}/${hashes.operations}`);
      await ready(page, 'operations');
      await expect.poll(async () => (await (await page.request.get(`${server.baseURL}/api/job-hunt/jobs/${server.ids['needs-1']}/notes`)).json()).body).toContain(note);
    } finally { await context.close(); }
  });

  test('selecting rows, switching tabs and moving with the arrow keys make no duplicate requests', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.panel, width: 1280 });
    try {
      const seen = [];
      await ready(page, 'panel'); // the first load has finished, so only the reload below is counted
      page.on('request', (request) => { if (request.method() === 'GET' && request.url().includes('/api/job-hunt/')) seen.push(new URL(request.url()).pathname); });
      await page.reload();
      await ready(page, 'panel');
      await page.waitForTimeout(400);
      const needs = server.ids['needs-1'];
      const count = (pattern) => seen.filter((path) => pattern.test(path)).length;
      expect(count(/\/opportunities$/), 'one table request on a deep link').toBe(1);
      expect(count(new RegExp(`/jobs/${needs}$`)), 'one job request on a deep link').toBe(1);

      const rows = page.locator('tr[data-job]');
      const first = await rows.nth(0).getAttribute('data-job');
      const role = await rows.nth(0).locator('[data-part="role"]').textContent();
      await rows.nth(0).locator('[data-col="company"]').click();
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toHaveText(role);
      await page.waitForTimeout(300);
      expect(count(new RegExp(`/jobs/${first}$`)), 'one request for a newly selected job').toBe(1);
      await rows.nth(0).locator('[data-col="company"]').click(); // the same row again
      await rows.nth(0).focus();
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown'); // moving focus is not selecting
      for (const tab of ['Match Analysis', 'Application', 'Company', 'Overview']) await page.locator('u2-job-detail-panel').getByRole('tab', { name: tab }).click();
      await page.waitForTimeout(400);
      expect(count(new RegExp(`/jobs/${first}$`)), 'no more requests for the same job').toBe(1);
      expect(count(/\/opportunities$/), 'selecting never reloads the table').toBe(1);
    } finally { await context.close(); }
  });

  test('a hidden tab stops polling Overview and Operations, and refreshes at once when it is visible again', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    for (const [kind, endpoint] of [['overview', '/api/job-hunt/overview'], ['operations', '/api/job-hunt/operations']]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: '#/job-hunt/opportunities', width: 1280 });
      try {
        await page.clock.install();
        await page.goto(`${server.baseURL}/${hashes[kind]}`);
        await ready(page, kind);
        const hits = [];
        page.on('request', (request) => { if (request.url().endsWith(endpoint)) hits.push(Date.now()); });
        const setHidden = (hidden) => page.evaluate((value) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);

        await page.clock.runFor(31_000);
        await expect.poll(() => hits.length, { message: `${kind}: a visible tab polls every 30 s` }).toBe(1);

        await setHidden(true);
        await page.clock.runFor(125_000);
        await page.waitForTimeout(200);
        expect(hits.length, `${kind}: no request while hidden`).toBe(1);

        await setHidden(false);
        await expect.poll(() => hits.length, { message: `${kind}: refreshes the moment it is visible` }).toBe(2);
        await page.clock.runFor(31_000);
        await expect.poll(() => hits.length, { message: `${kind}: polling resumes` }).toBe(3);
      } finally { await context.close(); }
    }
  });
});
