import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const id = (n) => `job_${String(n).padStart(16, '0')}`;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// #642: the quality pass over the Job Hunt Overview, Opportunities, detail panel and Agent Operations. Endpoints are stubbed
// with known data (the contracts are covered by the node tests); the checks here are about layout, keyboard, announcements
// and failure states, not about the numbers.

const ROWS = Array.from({ length: 60 }, (_, i) => ({
  id: id(i + 1), company: `A rather long company name number ${i + 1} Incorporated`, role: `Senior Staff Platform Engineer, Distributed Systems ${i + 1}`,
  locations: ['Oakland, CA'], remote: true, compensation: '$180K - $220K', skills: ['Node'], status: 'qualified', stage: 'qualified', needsInput: false, fit: 90 - (i % 40), fitLabel: 'strong',
  postedAt: '2026-10-01T12:00:00.000Z', firstSeenAt: '2026-10-02T12:00:00.000Z',
}));
const listFor = (url) => {
  const q = new URL(url).searchParams; const limit = Number(q.get('limit')) || 25; const page = Number(q.get('page')) || 1;
  return { items: ROWS.slice((page - 1) * limit, page * limit), total: ROWS.length, page, limit, counts: { all: ROWS.length, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 } };
};
const jobFor = (n, over = {}) => ({
  id: id(n), company: `A rather long company name number ${n} Incorporated`, role: `Senior Staff Platform Engineer ${n}`, status: 'qualified', locations: ['Oakland, CA'], remote: true, salary: '$180K', technologies: ['Node'], contactEmails: [], applicationUrls: [`https://jobs.example.com/apply/${n}`], companyUrl: null,
  firstSeenAt: '2026-10-02T12:00:00.000Z', score: { score: 88, label: 'strong', confidence: 0.8, degraded: false, model: 'm', scoredAt: '2026-10-03T12:00:00.000Z', narrative: 'x', reasons: ['Overlap'], concerns: [], projects: [], flags: [] },
  dimensions: {}, strategy: { name: 'FORM', reason: 'r' }, draft: null, materials: [], emails: [], sources: [], events: [], applications: [], reviews: [], contacts: [], tasks: [], interviews: [], attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: true, apple_mail: false, apple_mail_draft: false },
  ...over,
});
const stage = (sid, label, statuses, count, flag = false) => ({ id: sid, label, statuses, count, flag });
const OVERVIEW = {
  generatedAt: new Date().toISOString(), strongMatchScore: 80, minimumScore: 82, offPipeline: 0,
  metrics: [{ id: 'discovered', label: 'Jobs discovered', value: 4059, sub: '+312 this week', filter: 'all', statuses: null }],
  stages: [stage('discovered', 'Discovered', ['discovered'], 4000), stage('qualified', 'Qualified', ['qualified'], 42), stage('needs_input', 'Needs Input', [], 2, true)],
  attention: { count: 0, items: [] }, activity: [], autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: ago(120_000) },
};
const row = (over) => ({ tool: 'jobs.send_application', label: 'Send application email', requestedBy: 'job-autopilot', jobId: id(1), company: 'Company 1', role: 'Engineer 1', ...over });
const OPERATIONS = {
  generatedAt: new Date().toISOString(),
  autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: ago(120_000), cycleRunning: false, lastCycle: { startedAt: ago(300_000), finishedAt: ago(120_000), mode: 'dry_run', actions: 3, needsYou: 1, errors: 0 }, settingsChangedAt: null },
  running: { count: 0, items: [] },
  awaitingApproval: { count: 1, items: [row({ id: 'act_a', status: 'pending', since: ago(3_600_000) })] },
  recent: [], failures: [], lastActivity: { autopilotCycleAt: ago(120_000), lastActionAt: null, lastFailureAt: null },
};

// Signs in once; later pages reuse that session (the login route rate-limits repeated sign-ins).
let session = null;
async function signIn(browser, baseURL, hash, viewport) {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), ...(session ? { storageState: session } : {}) });
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  if (!session) {
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
    session = await context.storageState();
  }
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  return { context, page };
}

const stubAll = async (page, { writes = [] } = {}) => {
  page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.route('**/api/job-hunt/overview', (route) => route.fulfill({ json: OVERVIEW }));
  await page.route('**/api/job-hunt/operations', (route) => route.fulfill({ json: OPERATIONS }));
  await page.route('**/api/job-hunt/opportunities?**', (route) => route.fulfill({ json: listFor(route.request().url()) }));
  await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: jobFor(Number(route.request().url().slice(-16))) }) : route.fallback()));
  await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}\/notes$/, (route) => route.fulfill({ json: { jobId: id(1), path: 'x.md', exists: false, body: '', revision: null, updatedAt: null, maxBytes: 65536 } }));
};

const noPageScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test.describe.serial('job hunt quality pass (#642)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  for (const [name, width, height] of [['phone', 375, 800], ['tablet', 768, 1024], ['desktop', 1280, 800]]) {
    test(`no view scrolls the page sideways on a ${name} (${width}px), including the open detail panel`, async ({ browser }) => {
      const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt', { width, height });
      try {
        await stubAll(page);
        for (const hash of ['#/job-hunt', '#/job-hunt/opportunities', `#/job-hunt/opportunities?job=${id(2)}`, '#/job-hunt/operations']) {
          await page.goto(`${dedicated.baseURL}/${hash}`);
          await page.reload();
          await expect(page.locator('main h1, .workspace h1').first()).toBeVisible();
          if (hash.includes('?job=')) await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toBeVisible();
          if (hash.endsWith('opportunities')) await expect(page.locator('tr[data-job]')).toHaveCount(25);
          expect(await noPageScroll(page), `${hash} at ${width}px`).toBe(true);
        }
      } finally { await context.close(); }
    });
  }

  test('Escape closes the detail panel and returns focus to its row; the More menu takes the first Escape', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities', { width: 1280, height: 800 });
    try {
      await stubAll(page);
      await page.reload();
      const row3 = page.locator('tr[data-job]').nth(2);
      await row3.focus();
      await page.keyboard.press('Enter');
      const panel = page.locator('u2-job-detail-panel');
      await expect(panel.locator('[data-part="heading"]')).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`job=${id(3)}`));
      // The tabs follow the arrow-key pattern.
      await panel.getByRole('tab', { name: 'Overview' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(panel.getByRole('tab', { name: 'Match Analysis' })).toBeFocused();
      await expect(panel.getByRole('tab', { name: 'Match Analysis' })).toHaveAttribute('aria-selected', 'true');
      // The More menu takes the first Escape.
      await panel.locator('details[data-part="more"] summary').click();
      await page.keyboard.press('Escape');
      await expect(panel.locator('details[data-part="more"]')).not.toHaveAttribute('open', '');
      await expect(panel).toBeVisible();
      await panel.getByRole('tab', { name: 'Match Analysis' }).focus();
      await page.keyboard.press('Escape');
      await expect(page).not.toHaveURL(/job=/);
      await expect(page.locator('tr[data-job]').nth(2)).toBeFocused();
    } finally { await context.close(); }
  });

  test('the selected tab survives a reload and a visit to another view; another job starts on Overview', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(2)}`, { width: 1280, height: 800 });
    try {
      await stubAll(page);
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await panel.getByRole('tab', { name: 'Company' }).click();
      await expect(panel.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(panel.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true');
      await page.goto(`${dedicated.baseURL}/#/job-hunt/operations`);
      await expect(page.locator('u2-job-operations h1')).toBeVisible();
      await page.goBack();
      await expect(panel.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true');
      await page.locator('tr[data-job]').nth(4).locator('td[data-col="location"]').click();
      await expect(panel.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    } finally { await context.close(); }
  });

  test('a search or page change is announced in a live region; the table stays one page long', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities', { width: 1280, height: 800 });
    try {
      await stubAll(page);
      await page.reload();
      const live = page.locator('u2-job-opportunities [data-part="announce"]');
      await expect(live).toHaveAttribute('role', 'status');
      await expect(live).toHaveText('Showing 1–25 of 60 opportunities.');
      expect(await page.locator('tr[data-job]').count()).toBeLessThanOrEqual(25);
      await page.locator('[data-page="next"]').click();
      await expect(live).toHaveText('Showing 26–50 of 60 opportunities.');
    } finally { await context.close(); }
  });

  test('every view says plainly when its data cannot be loaded, and Opportunities announces it', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt', { width: 375, height: 800 });
    try {
      for (const pattern of ['**/api/job-hunt/overview', '**/api/job-hunt/operations', '**/api/job-hunt/opportunities?**']) {
        await page.route(pattern, (route) => route.fulfill({ status: 500, json: { error: 'database is locked' } }));
      }
      for (const [hash, tag, title] of [['#/job-hunt', 'u2-job-overview', "Couldn't load the overview"], ['#/job-hunt/operations', 'u2-job-operations', "Couldn't load agent operations"], ['#/job-hunt/opportunities', 'u2-job-opportunities', "Couldn't load opportunities"]]) {
        await page.goto(`${dedicated.baseURL}/${hash}`);
        await page.reload();
        const state = page.locator(`${tag} jh-state[kind="error"]`);
        await expect(state).toContainText(title);
        await expect(state).toHaveAttribute('role', 'alert');
        await expect(state.getByRole('button', { name: 'Try again' })).toBeVisible();
        expect(await noPageScroll(page)).toBe(true);
      }
      await expect(page.locator('u2-job-opportunities [data-part="announce"]')).toContainText('Could not load opportunities');
    } finally { await context.close(); }
  });

  test('a failed job load in the panel offers a retry and a missing job says so', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(2)}`, { width: 1280, height: 800 });
    try {
      await stubAll(page);
      let fail = true;
      await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => (fail ? route.fulfill({ status: 500, json: { error: 'database is locked' } }) : route.fallback()));
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await expect(panel.locator('jh-state[kind="error"]')).toContainText('database is locked');
      fail = false;
      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect(panel.locator('[data-part="heading"]')).toHaveText('Senior Staff Platform Engineer 2');
    } finally { await context.close(); }
  });

  test('Agent Operations keeps keyboard focus when it refreshes, and shows empty sections without inventing activity', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/operations', { width: 1280, height: 800 });
    try {
      let calls = 0;
      await stubAll(page);
      await page.route('**/api/job-hunt/operations', (route) => { calls += 1; return route.fulfill({ json: { ...OPERATIONS, generatedAt: new Date().toISOString() } }); });
      await page.reload();
      await expect(page.locator('[data-part="approval-count"]')).toHaveText('1');
      await expect(page.getByRole('region', { name: 'Running now' }).locator('jh-state[kind="empty"]')).toContainText('Nothing is running');
      await expect(page.getByRole('region', { name: 'Recent failures and errors' }).locator('jh-state[kind="empty"]')).toBeVisible();
      const link = page.getByRole('link', { name: 'Review in Operations' });
      await link.focus();
      const before = calls;
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.proposed' } })));
      await expect.poll(() => calls).toBeGreaterThan(before);
      await page.waitForTimeout(200);
      await expect(link).toBeFocused();
    } finally { await context.close(); }
  });

  test('regression: browsing every view, opening panels and tabs, and pressing Review sends no write; approval needs its own two steps', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt', { width: 1280, height: 800 });
    try {
      const writes = [];
      await stubAll(page, { writes });
      await page.reload();
      for (const hash of ['#/job-hunt', '#/job-hunt/operations', `#/job-hunt/opportunities?job=${id(3)}`]) { await page.goto(`${dedicated.baseURL}/${hash}`); await page.reload(); await page.waitForTimeout(150); }
      const panel = page.locator('u2-job-detail-panel');
      for (const tab of ['Match Analysis', 'Application', 'Company', 'Overview']) await panel.getByRole('tab', { name: tab }).click();
      expect(writes.filter((entry) => !/\/notes$/.test(entry))).toEqual([]);
      expect(writes.some((entry) => /autopilot|\/api\/actions\//.test(entry))).toBe(false);
    } finally { await context.close(); }
  });

  test('regression: approving a planned application posts only approve-and-submit with the plan hash, after two confirmations', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(3)}`, { width: 375, height: 800 });
    try {
      const writes = [];
      await stubAll(page, { writes });
      const planned = { id: 7, url: 'https://jobs.example.com/apply/3', status: 'planned', planHash: 'hash-3', createdAt: '2026-10-04T12:00:00.000Z', updatedAt: '2026-10-04T12:00:00.000Z', plan: { ready: true, needs: [], blockers: [], unresolved: [], fields: [{ label: 'Email', required: true, origin: 'profile', value: 'pat@example.com' }] }, result: { outcome: null, reason: null, errors: [], at: null, screenshots: [] } };
      await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => route.fulfill({ json: jobFor(3, { applications: [planned], reviews: [{ id: 3, kind: 'application', decision: 'approve', checks: [], concerns: [], notes: '', model: 'm', createdAt: '2026-10-05T12:00:00.000Z' }] }) }));
      await page.route(/\/approve-and-submit$/, (route) => route.fulfill({ json: { status: 'submitted', job: jobFor(3, { status: 'applied' }) } }));
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await panel.locator('[data-detail-action="primary"]').click();
      expect(writes).toEqual([]);
      await panel.getByRole('button', { name: 'Approve and submit…' }).click();
      expect(writes).toEqual([]);
      await panel.getByRole('button', { name: 'Yes, submit this application' }).click();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toBe(`POST /api/job-hunt/jobs/${id(3)}/approve-and-submit`);
      expect(await noPageScroll(page)).toBe(true);
    } finally { await context.close(); }
  });
});
