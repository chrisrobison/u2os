import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { seedHuntStore } from '../helpers/job-hunt-dashboard-seed.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';

const PASSPHRASE = 'correct horse battery staple';

// One login per server (repeated logins trip the sign-in limiter); each test
// gets its own page in that signed-in context, and `context.close()` closes it.
const sessions = new Map();
async function signIn(browser, baseURL, hash) {
  let context = sessions.get(baseURL);
  const fresh = !context;
  if (fresh) { context = await browser.newContext(); sessions.set(baseURL, context); }
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  if (fresh) {
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
  }
  return { context: { close: () => page.close() }, page };
}
async function endSession(baseURL) {
  await sessions.get(baseURL)?.close();
  sessions.delete(baseURL);
}

const column = (page, label) => page.locator('u2-job-pipeline .jh-col', { has: page.locator('.jh-col__label', { hasText: new RegExp(`^${label}$`) }) });
const card = (page, company) => page.locator('u2-job-pipeline .jh-card', { hasText: company });

test.describe.serial('job-hunt dashboard (#535)', () => {
  let dedicated;
  let vault;
  let ids;

  test.beforeAll(async () => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    vault = path.join(dedicated._dataDir, 'vault');
    ids = seedHuntStore(vault);
  });

  test.afterAll(async () => { await endSession(dedicated.baseURL); await stopDedicatedServer(null, dedicated); });

  test('shows the six stages with counts, cards, fit chips, a greeting with real counts and details', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await expect(page.locator('u2-job-dashboard h1')).toHaveText(/Good (morning|afternoon|evening)/);
      await expect(page.locator('.jh-sub')).toContainText('You sent 2 applications this week');
      await expect(page.locator('.jh-sub')).toContainText('1 follow-up is due');
      await expect(page.locator('.jh-sub')).toContainText('8 jobs in your pipeline');

      await expect(page.locator('u2-job-pipeline .jh-col__label')).toHaveText(['Saved', 'Applied', 'Recruiter Screen', 'Interviewing', 'Offer', 'Rejected']);
      await expect(page.locator('u2-job-pipeline .jh-col__count')).toHaveText(['2', '2', '1', '1', '1', '1']);
      await expect(page.locator('.jh-pipeline__total')).toHaveText('8 jobs total');
      await expect(column(page, 'Saved').locator('.jh-card')).toHaveCount(2);
      await expect(column(page, 'Applied').locator('.jh-card').first()).toContainText('Initech');
      await expect(card(page, 'Acme Robotics').locator('.jh-fit')).toHaveText('92% fit');
      await expect(card(page, 'Acme Robotics').locator('.jh-fit')).toHaveClass(/jh-fit--high/);
      await expect(card(page, 'Initech').locator('.jh-fit')).toHaveClass(/jh-fit--good/);
      await expect(card(page, 'Northwind').locator('.jh-fit')).toHaveClass(/jh-fit--low/);
      await expect(card(page, 'Initech')).toContainText('Follow-up due');
      await expect(card(page, 'Acme Robotics')).toContainText('Oakland, CA');

      // Nothing is selected by the owner yet: the most live job fills the details.
      await expect(page.locator('u2-job-details .jh-details__role')).toHaveText('Director of Engineering');
      await expect(card(page, 'Delta Systems')).toHaveAttribute('aria-pressed', 'true');

      // Hidden until interviews, follow-ups and contacts exist (#536, #537), and no upsell or coach.
      await expect(page.getByText(/Upcoming Interviews|Tasks & Follow-ups|Networking|Upgrade to Pro|Career Coach/i)).toHaveCount(0);
    } finally { await context.close(); }
  });

  test('selecting a card fills the details tabs: overview, fit, notes and activity', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await card(page, 'Hooli').click();
      const details = page.locator('u2-job-details');
      await expect(details.locator('.jh-details__company')).toHaveText('Hooli');
      await expect(details.locator('.jh-details__role')).toHaveText('Principal Engineer');
      await expect(details).toContainText('$180K - $220K');
      await expect(details.locator('svg.jh-ring')).toHaveAttribute('aria-label', 'Fit 90 percent, exceptional');
      await expect(details.locator('.jh-ring__num')).toHaveText('90%');
      await expect(details.locator('.jh-tabpanel')).toContainText('Hooli is hiring a Principal Engineer');
      await expect(details.locator('a', { hasText: 'View on company site' })).toBeHidden();

      await card(page, 'Delta Systems').click();
      await expect(details.locator('a', { hasText: 'View on company site' })).toHaveAttribute('href', 'https://delta.example.com/');
      await expect(details.locator('.jh-tags .jh-tag')).toHaveCount(9);
      await expect(details.locator('.jh-tags .jh-tag').last()).toHaveText('+2');
      await expect(details.locator('a', { hasText: 'Open application' })).toHaveAttribute('href', 'https://jobs.example.com/interview-1');

      await details.getByRole('tab', { name: 'Fit & Skills' }).click();
      await expect(details.locator('.jh-tabpanel')).toContainText('88 out of 100, strong');
      await expect(details.locator('.jh-dim')).toHaveCount(3);
      await expect(details.locator('.jh-dim').first()).toContainText('22/25');
      await expect(details.locator('.jh-tabpanel')).toContainText('Direct platform experience');
      await expect(details.locator('.jh-tabpanel')).toContainText('Salary not stated');
      await expect(details.locator('.jh-tabpanel')).toContainText('u2os: Local-first agent');

      await details.getByRole('tab', { name: 'Notes' }).click();
      await expect(details.locator('.jh-tabpanel')).toContainText('No notes for this job');

      await details.getByRole('tab', { name: 'Activity' }).click();
      const items = details.locator('.jh-timeline__item');
      await expect(items.first()).toContainText('Screening → Interview');
      await expect(items.last()).toContainText('Discovered');

      // Arrow keys move between tabs.
      await details.getByRole('tab', { name: 'Activity' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(details.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    } finally { await context.close(); }
  });

  test('analytics tiles and the resume versions come from the dashboard API', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      const tiles = page.locator('u2-job-analytics .jh-tile');
      await expect(tiles).toHaveCount(4);
      await expect(tiles.nth(0)).toContainText('Applications Sent');
      await expect(tiles.nth(0).locator('.jh-tile__value')).toHaveText('6');
      await expect(tiles.nth(0)).toContainText('+6 vs prior 30 days');
      await expect(tiles.nth(0).locator('svg.jh-spark')).toHaveAttribute('aria-label', /6 in total/);
      expect(await tiles.nth(0).locator('svg.jh-spark rect').count()).toBeGreaterThanOrEqual(30);
      await expect(tiles.nth(1)).toContainText('Interview Rate');
      await expect(tiles.nth(1).locator('.jh-tile__value')).toHaveText('50%');
      await expect(tiles.nth(2)).toContainText('Response Rate');
      await expect(tiles.nth(2).locator('.jh-tile__value')).toHaveText('67%');
      await expect(tiles.nth(3)).toContainText('Offers');
      await expect(tiles.nth(3).locator('.jh-tile__value')).toHaveText('1');

      await page.locator('#jh-window').selectOption('7');
      await expect(page.locator('u2-job-analytics .jh-tile__value').first()).toHaveText('2');

      const versions = page.locator('u2-job-resumes .jh-version');
      await expect(versions).toHaveCount(2);
      await expect(page.locator('u2-job-resumes')).toContainText('resume-platform.pdf');
      await expect(page.locator('u2-job-resumes')).toContainText('Used for 2 jobs: Vandelay, Delta Systems');
      await expect(page.locator('u2-job-resumes')).toContainText('cover-delta.pdf');
      await expect(page.locator('u2-job-resumes')).toContainText('Cover letter');
    } finally { await context.close(); }
  });

  test('search filters the pipeline and group-by regroups it by fit', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await expect(page.locator('.jh-card')).toHaveCount(8);
      await page.locator('#jh-search').fill('delta');
      await expect(page.locator('.jh-card')).toHaveCount(1);
      await expect(page.locator('.jh-pipeline__total')).toHaveText('1 of 8 jobs match');
      await page.locator('#jh-search').fill('oakland');
      await expect(page.locator('.jh-card')).toHaveCount(8);
      await page.locator('#jh-search').fill('no such company');
      await expect(page.locator('.jh-card')).toHaveCount(0);
      await expect(page.locator('.jh-col__empty').first()).toHaveText('No matches');
      await page.locator('#jh-search').fill('');
      await expect(page.locator('.jh-card')).toHaveCount(8);

      await page.locator('#jh-groupby').selectOption('fit');
      await expect(page.locator('u2-job-pipeline .jh-col__label')).toHaveText(['High fit (85+)', 'Good fit (70-84)', 'Lower fit (under 70)', 'Not scored']);
      await expect(page.locator('u2-job-pipeline .jh-col__count')).toHaveText(['5', '2', '1', '0']);
      await expect(column(page, 'High fit \\(85\\+\\)').locator('.jh-card').first()).toContainText('Acme Robotics');
    } finally { await context.close(); }
  });

  test('the owner moves jobs through the status endpoint and the board, counts and activity follow', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      const details = page.locator('u2-job-details');
      // A saved job has no company answer to record.
      await card(page, 'Acme Robotics').click();
      await expect(details.locator('.jh-details__role')).toHaveText('Staff Engineer');
      await expect(details.getByRole('button', { name: /Move to|Mark rejected/ })).toHaveCount(1);
      await expect(details.getByRole('button', { name: 'Mark rejected' })).toBeVisible();

      await card(page, 'Globex').click();
      await expect(details.locator('.jh-details__role')).toHaveText('Engineering Manager');
      await details.getByRole('button', { name: 'Move to Recruiter Screen' }).click();
      await expect(details.locator('.jh-note[role="status"]')).toHaveText('Moved to Recruiter Screen.');
      await expect(column(page, 'Recruiter Screen').locator('.jh-card')).toHaveCount(2);
      await expect(column(page, 'Applied').locator('.jh-card')).toHaveCount(1);
      await expect(card(page, 'Globex')).toHaveAttribute('aria-pressed', 'true');
      await expect(details.getByRole('button', { name: 'Move to Recruiter Screen' })).toHaveCount(0);
      await details.getByRole('tab', { name: 'Activity' }).click();
      await expect(details.locator('.jh-timeline__item').first()).toContainText('Applied → Screening (you)');

      await details.getByRole('tab', { name: 'Overview' }).click();
      await details.getByRole('button', { name: 'Move to Offer' }).click();
      await expect(column(page, 'Offer').locator('.jh-card')).toHaveCount(2);
      await details.getByRole('button', { name: 'Mark rejected' }).click();
      await expect(column(page, 'Rejected').locator('.jh-card')).toHaveCount(2);
      await expect(page.locator('.jh-pipeline__total')).toHaveText('8 jobs total');
    } finally { await context.close(); }
  });

  test('refreshes on jobs and action events, and ignores unrelated ones', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await expect(page.locator('.jh-pipeline__total')).toHaveText('8 jobs total');
      const store = openStore(huntDbPath(vault));
      try {
        const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:late#0', company: 'Latecomer', role: 'Engineer', rawText: 'x', applicationUrls: [], contactEmails: [], locations: [] }, new Date());
        store.transition(job.id, 'qualified', {}, new Date());
      } finally { store.close(); }
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'task.updated' } })));
      await page.waitForTimeout(600);
      await expect(page.locator('.jh-pipeline__total')).toHaveText('8 jobs total');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.completed' } })));
      await expect(page.locator('.jh-pipeline__total')).toHaveText('9 jobs total');
      await expect(card(page, 'Latecomer')).toContainText('No score');
    } finally { await context.close(); }
  });

  test('posting text is shown as text, and non-http links are never made clickable', async ({ browser }) => {
    const store = openStore(huntDbPath(vault));
    try {
      const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:evil#0', company: '<img src=x onerror="window.__xss=1">Evil', role: '<script>window.__xss=2</script>', rawText: '<img src=x onerror="window.__xss=3"> listing', applicationUrls: ['javascript:window.__xss=4'], contactEmails: [], locations: ['<b>Nowhere</b>'], companyUrl: 'javascript:window.__xss=5' }, new Date());
      store.transition(job.id, 'interview', {}, new Date());
    } finally { store.close(); }
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      const evil = page.locator('.jh-card', { hasText: 'Evil' });
      await expect(evil).toContainText('<script>window.__xss=2</script>');
      await evil.click();
      await expect(page.locator('u2-job-details .jh-tabpanel')).toContainText('<img src=x onerror="window.__xss=3"> listing');
      await expect(page.locator('u2-job-details a[href^="javascript"]')).toHaveCount(0);
      await expect(page.locator('u2-job-details a', { hasText: /View on company site|Open application/ })).toHaveCount(0);
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('u2-job-dashboard img, u2-job-dashboard script').count()).toBe(0);
    } finally { await context.close(); }
  });

  test('has no axe violations, with the board keyboard reachable, on desktop and phone', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await expect(page.locator('.jh-card').first()).toBeVisible();
      await expect(page.locator('u2-job-details .jh-details__role')).toBeVisible();
      let results = await new AxeBuilder({ page }).include('u2-job-dashboard').analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

      await page.locator('.jh-card').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.jh-card[aria-pressed="true"]')).toHaveCount(1);

      await page.setViewportSize({ width: 390, height: 800 });
      await expect(page.locator('u2-job-dashboard h1')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const board = page.locator('.jh-board');
      expect(await board.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      results = await new AxeBuilder({ page }).include('u2-job-dashboard').analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    } finally { await context.close(); }
  });

  test('Job Leads keeps the ranked list at its own route', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/leads');
    try {
      await expect(page.locator('.workspace__title', { hasText: 'Job Leads' })).toBeVisible();
      await expect(page.locator('u2-nav a[data-route="#/job-hunt/leads"]')).toHaveClass(/is-active/);
      await expect(page.locator('u2-nav a[data-route="#/job-hunt"]')).not.toHaveClass(/is-active/);
      await expect(page.locator('u2-job-dashboard')).toHaveCount(0);
    } finally { await context.close(); }
  });
});

test('a fresh install shows honest empty states and no fake data', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
  try {
    await expect(page.locator('.jh-sub')).toHaveText('Nothing in your pipeline yet.');
    await expect(page.locator('u2-job-pipeline')).toContainText('No jobs in your pipeline yet.');
    await expect(page.locator('.jh-pipeline__total')).toHaveText('0 jobs total');
    await expect(page.locator('u2-job-details')).toContainText('Select a job in the pipeline');
    await expect(page.locator('u2-job-analytics .jh-tile__value')).toHaveText(['0', '–', '–', '0']);
    await expect(page.locator('u2-job-analytics')).toContainText('Nothing has been sent in this window yet');
    await expect(page.locator('u2-job-resumes')).toContainText('No resumes or cover letters yet');
    const results = await new AxeBuilder({ page }).include('u2-job-dashboard').analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
  } finally {
    await context.close();
    await endSession(dedicated.baseURL);
    await stopDedicatedServer(null, dedicated);
  }
});
