import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const id = (n) => `job_${String(n).padStart(16, '0')}`;

// #631: the Opportunities table at #/job-hunt/opportunities. The opportunities endpoint is stubbed with a small
// in-memory implementation of the same contract so the page's behaviour (URL state, keyboard, selection, paging) is
// exercised against known data; the server query itself is covered in tests/job-hunt-opportunities.test.js.

const JOBS = Array.from({ length: 30 }, (_, i) => ({
  id: id(i + 1), company: `Company ${String(i + 1).padStart(2, '0')}`, role: i === 3 ? null : `Engineer ${i + 1}`,
  locations: i % 2 ? ['Oakland, CA'] : [], remote: i % 3 === 0 ? true : null, compensation: i % 2 ? '$180K - $220K' : null, skills: ['Node'],
  status: i < 4 ? 'needs_input' : i < 10 ? 'applied' : 'qualified', stage: null, needsInput: i < 4,
  fit: i === 5 ? null : 95 - i, fitLabel: null, postedAt: i % 2 ? '2026-10-01T00:00:00.000Z' : null, firstSeenAt: '2026-10-02T00:00:00.000Z',
}));
const FILTERS = { all: () => true, needs_input: (j) => j.needsInput, ready: () => false, applied: (j) => j.status === 'applied', responded: () => false, archived: () => false };

function serve(url) {
  const q = new URL(url).searchParams;
  const filter = q.get('filter') || 'all';
  const scoped = JOBS.filter((j) => (!q.get('q') || `${j.company} ${j.role}`.toLowerCase().includes(q.get('q').toLowerCase())) && (!q.get('min_score') || (j.fit ?? -1) >= Number(q.get('min_score'))) && (!q.get('stage') || j.status === 'applied'));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([key, fn]) => [key, scoped.filter(fn).length]));
  const sign = q.get('dir') === 'asc' ? 1 : -1;
  const key = { company: (j) => j.company, fit: (j) => j.fit }[q.get('sort')] ?? ((j) => j.fit);
  const list = scoped.filter(FILTERS[filter]).sort((a, b) => (key(a) === null) - (key(b) === null) || (key(a) > key(b) ? sign : key(a) < key(b) ? -sign : 0) || (a.id < b.id ? -1 : 1));
  const limit = Number(q.get('limit')) || 25; const page = Number(q.get('page')) || 1;
  return { items: list.slice((page - 1) * limit, page * limit), total: list.length, page, limit, counts };
}

async function signIn(browser, baseURL, hash) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  return { context, page };
}

test.describe.serial('job hunt opportunities table (#631)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  const stub = async (page, record = []) => {
    await page.route('**/api/job-hunt/opportunities?**', (route) => { record.push(route.request().url()); route.fulfill({ json: serve(route.request().url()) }); });
  };

  test('renders the grid with counts, dashes for missing values, and passes an accessibility check', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      await stub(page);
      await page.reload();
      await expect(page.locator('u2-job-opportunities h1')).toHaveText('Opportunities');
      const rows = page.locator('tr[data-job]');
      await expect(rows).toHaveCount(25);
      await expect(page.getByRole('grid', { name: 'Opportunities' })).toHaveAttribute('aria-rowcount', '31');
      await expect(page.locator('[data-filter="all"] .jh-opp__count')).toHaveText('30');
      await expect(page.locator('[data-filter="needs_input"] .jh-opp__count')).toHaveText('4');
      await expect(page.locator('[data-filter="applied"] .jh-opp__count')).toHaveText('6');
      // Row 4 has no role, row 3 no location or compensation; row 1 has no posted date (a job with no score sorts last).
      const fourth = rows.nth(3);
      await expect(fourth.locator('[data-part="role"]')).toHaveText('—');
      await expect(rows.nth(2).locator('[data-part="comp"]')).toHaveText('—');
      await expect(rows.nth(2).locator('[data-part="location"]')).toHaveText('—');
      await expect(fourth.locator('[data-part="status"]')).toContainText('Needs input');
      await expect(rows.first().locator('[data-part="posted"]')).toHaveText('—');
      await expect(page.locator('[data-part="range"]')).toHaveText('1–25 of 30');
      const axe = await new AxeBuilder({ page }).include('u2-job-opportunities').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      // One nav entry for Opportunities, Job Leads and Applications are still there.
      await expect(page.locator('u2-nav a[href="#/job-hunt/opportunities"]')).toHaveCount(1);
      await expect(page.locator('u2-nav a[href="#/job-hunt/opportunities"]')).toHaveClass(/is-active/);
      await expect(page.locator('u2-nav a[href="#/job-hunt/leads"]')).toHaveCount(1);
      await expect(page.locator('u2-nav a[href="#/applications"]')).toHaveCount(1);
    } finally { await context.close(); }
  });

  test('tabs, sort, search, paging and filters are kept in the URL and survive a reload', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      const seen = [];
      await stub(page, seen);
      await page.reload();
      await page.locator('[data-filter="applied"]').click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities\?filter=applied$/);
      await expect(page.locator('tr[data-job]')).toHaveCount(6);
      await page.locator('[data-filter="all"]').click();
      await page.locator('[data-page="next"]').click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities\?page=2$/);
      await expect(page.locator('tr[data-job]')).toHaveCount(5);
      await expect(page.locator('[data-part="range"]')).toHaveText('26–30 of 30');
      await expect(page.locator('[data-page="next"]')).toBeDisabled();

      await page.getByRole('button', { name: 'Company', exact: true }).click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities\?sort=company$/);
      await expect(page.locator('th[data-col="company"]')).toHaveAttribute('aria-sort', 'ascending');
      await expect(page.locator('tr[data-job]').first().locator('[data-part="company"]')).toHaveText('Company 01');
      await page.getByRole('button', { name: 'Company', exact: true }).click();
      await expect(page.locator('tr[data-job]').first().locator('[data-part="company"]')).toHaveText('Company 30');

      await page.getByLabel('Search opportunities').fill('company 07');
      await expect(page.locator('tr[data-job]')).toHaveCount(1);
      await expect(page).toHaveURL(/q=company(\+|%20)07/);
      await page.reload();
      await expect(page.getByLabel('Search opportunities')).toHaveValue('company 07');
      await expect(page.locator('tr[data-job]')).toHaveCount(1);
      const asked = new URL(seen.at(-1)).searchParams;
      expect(asked.get('q')).toBe('company 07');
      expect(asked.get('sort')).toBe('company');
      expect(asked.get('dir')).toBe('desc');

      await page.getByLabel('Search opportunities').fill('no such company');
      await expect(page.locator('jh-state[kind="empty"]')).toContainText('No opportunities match');
      await page.getByRole('button', { name: 'Clear search and filters' }).click();
      await expect(page.locator('tr[data-job]')).toHaveCount(25);

      await page.getByRole('button', { name: 'Filters', exact: true }).click();
      await page.locator('#jh-opp-floor').selectOption('80');
      await expect(page).toHaveURL(/min_score=80/);
    } finally { await context.close(); }
  });

  test('keyboard: arrows move between rows, Space selects, Enter selects, select-all covers the page', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      await stub(page);
      await page.reload();
      const rows = page.locator('tr[data-job]');
      await expect(rows).toHaveCount(25);
      await expect(rows.first()).toHaveAttribute('tabindex', '0');
      await expect(rows.nth(1)).toHaveAttribute('tabindex', '-1');
      await rows.first().focus();
      await page.keyboard.press('ArrowDown');
      await expect(rows.nth(1)).toBeFocused();
      await expect(rows.nth(1)).toHaveAttribute('tabindex', '0');
      await expect(rows.first()).toHaveAttribute('tabindex', '-1');
      await page.keyboard.press('End');
      await expect(rows.nth(24)).toBeFocused();
      await page.keyboard.press('Home');
      await expect(rows.first()).toBeFocused();

      await page.keyboard.press('Space');
      await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
      await expect(rows.first().locator('input[type="checkbox"]')).toBeChecked();
      await expect(page.locator('[data-part="selected-count"]')).toHaveText('1 selected');
      await page.keyboard.press('Space');
      await expect(rows.first()).toHaveAttribute('aria-selected', 'false');

      await page.getByLabel('Select all opportunities on this page').check();
      await expect(page.locator('tr[data-job][aria-selected="true"]')).toHaveCount(25);
      await expect(page.locator('[data-part="selected-count"]')).toHaveText('25 selected');
      await page.getByRole('button', { name: 'Clear selection' }).click();
      await expect(page.locator('tr[data-job][aria-selected="true"]')).toHaveCount(0);

      await rows.nth(2).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/opportunities\\?job=${id(3)}$`));
      await expect(page.locator('u2-job-detail-panel')).toBeVisible();
    } finally { await context.close(); }
  });

  test('clicking a row fires jh-opportunity-select, marks it, and the mark survives paging', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      await stub(page);
      await page.reload();
      await page.evaluate(() => { window.__picked = []; document.addEventListener('jh-opportunity-select', (e) => window.__picked.push(e.detail.jobId)); });
      await page.locator('tr[data-job]').nth(1).locator('td[data-col="location"]').click();
      expect(await page.evaluate(() => window.__picked)).toEqual([id(2)]);
      await expect(page.locator('tr[data-job]').nth(1)).toHaveAttribute('aria-current', 'true');
      await page.locator('[data-page="next"]').click();
      await page.locator('[data-page="prev"]').click();
      await expect(page.locator(`tr[data-job="${id(2)}"]`)).toHaveAttribute('aria-current', 'true');
      await expect(page).not.toHaveURL(/jobs\//);
    } finally { await context.close(); }
  });

  test('bulk reject calls the status endpoint per selected job after a confirmation', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      await stub(page);
      const posts = [];
      await page.route('**/api/job-hunt/jobs/*/status', (route) => { posts.push([route.request().url().split('/').at(-2), route.request().postDataJSON()]); route.fulfill({ json: { changed: true } }); });
      await page.reload();
      await page.locator('tr[data-job]').nth(0).locator('input[type="checkbox"]').check();
      await page.locator('tr[data-job]').nth(1).locator('input[type="checkbox"]').check();
      await page.getByRole('button', { name: 'Reject selected' }).click();
      await expect(page.locator('dialog[open]')).toContainText('Reject 2 jobs');
      await page.locator('dialog[open] [data-confirm]').click();
      await expect(page.locator('.jh-opp__notice')).toContainText('Rejected 2 jobs');
      expect(posts).toEqual([[id(1), { status: 'rejected' }], [id(2), { status: 'rejected' }]]);
      await expect(page.locator('[data-part="selected-count"]')).toHaveCount(0);
    } finally { await context.close(); }
  });

  test('an error offers a retry and Job Leads is still reachable', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      let fail = true;
      await page.route('**/api/job-hunt/opportunities?**', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'database is locked' } }) : route.fulfill({ json: serve(route.request().url()) })));
      await page.reload();
      await expect(page.locator('jh-state[kind="error"]')).toContainText('database is locked');
      fail = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('tr[data-job]')).toHaveCount(25);
      await page.locator('u2-nav a[href="#/job-hunt/leads"]').click();
      await expect(page.locator('u2-job-hunt')).toBeVisible();
    } finally { await context.close(); }
  });
});
