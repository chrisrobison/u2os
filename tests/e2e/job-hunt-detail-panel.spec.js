import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const id = (n) => `job_${String(n).padStart(16, '0')}`;

// #634: the job detail panel beside the Opportunities table. The opportunities, job and notes endpoints are stubbed with
// small in-memory implementations of their contracts, so the panel's behaviour (URL, focus, tabs, drawer, notes conflicts,
// approvals) is exercised against known data. The notes module and routes are covered by tests/job-hunt-notes.test.js.

const ROWS = [1, 2, 3].map((n) => ({
  id: id(n), company: `Company ${n}`, role: `Engineer ${n}`, locations: ['Oakland, CA'], remote: true, compensation: '$180K', skills: ['Node'],
  status: 'qualified', stage: 'qualified', needsInput: false, fit: 90 - n, fitLabel: 'strong', postedAt: '2026-10-01T12:00:00.000Z', firstSeenAt: '2026-10-02T12:00:00.000Z',
}));

const planned = { id: 7, url: 'https://jobs.example.com/apply/3', status: 'planned', planHash: 'hash-3', createdAt: '2026-10-04T12:00:00.000Z', updatedAt: '2026-10-04T12:00:00.000Z', plan: { ready: true, needs: [], blockers: [], unresolved: [], fields: [{ label: 'Email', required: true, origin: 'profile', value: 'pat@example.com' }] }, result: { outcome: null, reason: null, errors: [], at: null, screenshots: [] } };

function jobFor(n, over = {}) {
  return {
    id: id(n), company: `Company ${n}`, role: `Engineer ${n}`, status: 'qualified', locations: ['Oakland, CA'], remote: true, salary: '$180K - $220K',
    technologies: ['Node', 'SQLite'], contactEmails: [], applicationUrls: [`https://jobs.example.com/apply/${n}`], companyUrl: 'https://example.com', firstSeenAt: '2026-10-02T12:00:00.000Z',
    score: { score: 90 - n, label: 'strong', confidence: 0.8, degraded: false, model: 'model-x', scoredAt: '2026-10-03T12:00:00.000Z', narrative: 'x', reasons: ['Direct overlap with agent systems'], concerns: ['Team size unclear'], projects: [{ name: 'u2', url: 'https://github.com/me/u2', why: 'An agent runtime' }], flags: [] },
    dimensions: { experience: { points: 22, max: 25, reason: 'Ten years of backend work' }, location: { points: 8, max: 10, reason: 'Remote, US-compatible' }, compensation: { points: 5, max: 5, reason: 'Range meets the minimum' } },
    strategy: { name: 'FORM', reason: 'The listing has an application form.' }, draft: null, materials: [{ kind: 'resume', file: 'resume.pdf' }], emails: [],
    sources: [{ source: 'hackernews', author: 'pat', url: 'https://news.ycombinator.com/item?id=1', postedAt: '2026-10-01T12:00:00.000Z', rawText: 'text' }],
    events: [{ id: 1, at: '2026-10-02T12:00:00.000Z', type: 'status', fromStatus: null, toStatus: 'qualified' }],
    applications: [], reviews: [], contacts: [], tasks: [], interviews: [], attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: true, apple_mail: false, apple_mail_draft: false },
    ...over,
  };
}

async function signIn(browser, baseURL, hash, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  return { context, page };
}

test.describe.serial('job hunt detail panel (#634)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  const stub = async (page, { jobs = {}, notes = {}, writes = [] } = {}) => {
    const noteState = { body: '', revision: null, exists: false, ...notes };
    await page.route('**/api/job-hunt/opportunities?**', (route) => route.fulfill({ json: { items: ROWS, total: 3, page: 1, limit: 25, counts: { all: 3, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 } } }));
    await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => {
      const n = Number(route.request().url().slice(-16));
      if (route.request().method() !== 'GET') return route.fallback();
      const entry = jobs[n];
      if (entry === 404) return route.fulfill({ status: 404, json: { error: 'No such job' } });
      return route.fulfill({ json: jobFor(n, entry ?? {}) });
    });
    await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}\/notes$/, (route) => {
      const request = route.request();
      const jobId = request.url().split('/').at(-2);
      const current = () => ({ jobId, path: `job-hunt/notes/${jobId}.md`, exists: noteState.exists, body: noteState.body, revision: noteState.revision, updatedAt: noteState.exists ? '2026-10-29T12:00:00.000Z' : null, maxBytes: 65536 });
      if (request.method() === 'GET') return route.fulfill({ json: current() });
      const sent = request.postDataJSON();
      writes.push(['notes', sent]);
      if (sent.revision !== noteState.revision) return route.fulfill({ status: 409, json: { error: 'This note changed since you opened it', code: 'CONFLICT', note: current() } });
      Object.assign(noteState, { body: sent.body.trim(), exists: Boolean(sent.body.trim()), revision: `rev-${writes.length}` });
      return route.fulfill({ json: current() });
    });
    return noteState;
  };

  test('selecting a row opens the panel beside the table; the URL, the reload and Back follow; the panel is accessible', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities?sort=company');
    try {
      await stub(page);
      await page.reload();
      await expect(page.locator('tr[data-job]')).toHaveCount(3);
      await expect(page.locator('u2-job-detail-panel')).toBeHidden();
      await page.locator('tr[data-job]').nth(1).locator('td[data-col="location"]').click();
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/opportunities\\?sort=company&job=${id(2)}$`));
      const heading = page.locator('u2-job-detail-panel [data-part="heading"]');
      await expect(heading).toHaveText('Engineer 2');
      await expect(heading).toBeFocused();
      await expect(page.locator('tr[data-job]').nth(1)).toHaveAttribute('aria-current', 'true');
      // Side by side: the table keeps its place and the panel sits to its right.
      const table = await page.locator('table.jh-opp__table').boundingBox();
      const panel = await page.locator('u2-job-detail-panel').boundingBox();
      expect(panel.x).toBeGreaterThan(table.x + 100);
      await expect(page.locator('u2-job-detail-panel [data-part="fit"]')).toHaveText('88% fit');
      await expect(page.locator('u2-job-detail-panel [data-part="meta"]')).toContainText('$180K - $220K');
      await expect(page.locator('u2-job-detail-panel [data-part="posting"]')).toHaveAttribute('href', 'https://jobs.example.com/apply/2');
      const axe = await new AxeBuilder({ page }).include('u2-job-detail-panel').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

      // A second row replaces the content without leaving the table.
      await page.locator('tr[data-job]').first().locator('td[data-col="location"]').click();
      await expect(heading).toHaveText('Engineer 1');
      await expect(page).toHaveURL(new RegExp(`job=${id(1)}$`));

      await page.reload();
      await expect(heading).toHaveText('Engineer 1');
      await expect(page.locator('tr[data-job]').first()).toHaveAttribute('aria-current', 'true');
      await expect(page.getByLabel('Sort by')).toHaveValue('company');

      // Each selection is a history entry: Back steps through them (job 1 was the second pick, job 2 the first), then closes.
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`job=${id(2)}$`));
      await expect(heading).toHaveText('Engineer 2');
      await page.goBack();
      await expect(page).not.toHaveURL(/job=/);
      await expect(page.locator('u2-job-detail-panel')).toBeHidden();
    } finally { await context.close(); }
  });

  test('closing the panel clears the job and returns focus to the row; Enter on a row opens it; a deleted job says so', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      await stub(page, { jobs: { 3: 404 } });
      await page.reload();
      const rows = page.locator('tr[data-job]');
      await rows.nth(1).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/opportunities\\?job=${id(2)}$`));
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toBeFocused();
      await page.getByRole('button', { name: 'Close job details' }).click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities$/);
      await expect(page.locator('u2-job-detail-panel')).toBeHidden();
      await expect(rows.nth(1)).toBeFocused();
      await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');

      await rows.nth(2).locator('td[data-col="location"]').click();
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toHaveText('Job not found');
      await expect(page.locator('u2-job-detail-panel jh-state')).toContainText('no longer exists');
      await expect(page.locator('tr[data-job]')).toHaveCount(3);
    } finally { await context.close(); }
  });

  test('below 900px the panel is a drawer: it opens on selection and Escape closes it, clears the URL and returns focus', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities', { width: 800, height: 900 });
    try {
      await stub(page);
      await page.reload();
      await expect(page.locator('tr[data-job]')).toHaveCount(3);
      await expect(page.locator('u2-job-detail-panel')).toBeHidden();
      await page.locator('tr[data-job]').first().locator('td[data-col="location"]').click();
      const heading = page.locator('u2-job-detail-panel [data-part="heading"]');
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      const box = await page.locator('jh-workspace > [data-region="detail"]').boundingBox();
      expect(box.x + box.width).toBeGreaterThan(780);
      await page.keyboard.press('Escape');
      await expect(page.locator('u2-job-detail-panel')).toBeHidden();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities$/);
      await expect(page.locator('tr[data-job]').first()).toBeFocused();
    } finally { await context.close(); }
  });

  test('tabs: Match Analysis separates verified, unverified and confirmed gaps; Application and Company render stored data', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(3)}`);
    try {
      await stub(page, { jobs: { 3: { applications: [planned], reviews: [{ id: 3, kind: 'application', decision: 'approve', checks: [{ name: 'form_answers_supported_by_facts', pass: true }], concerns: [], notes: '', model: 'm', createdAt: '2026-10-05T12:00:00.000Z' }], contacts: [{ name: 'Rae', email: 'rae@example.com', roleKind: 'recruiter' }], companyUrl: 'javascript:alert(1)' } } });
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await expect(panel.locator('[data-part="heading"]')).toHaveText('Engineer 3');
      await expect(panel.getByRole('tab')).toHaveText(['Overview', 'Match Analysis', 'Application', 'Company', 'Notes']);
      await expect(panel.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.getByRole('tabpanel')).toContainText('Why this is a strong match');
      await expect(panel.getByRole('tabpanel')).toContainText('Direct overlap with agent systems');
      await expect(panel.getByRole('tabpanel')).toContainText('Gaps to address');

      await panel.getByRole('tab', { name: 'Overview' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(panel.getByRole('tab', { name: 'Match Analysis' })).toBeFocused();
      await expect(panel.getByRole('tab', { name: 'Match Analysis' })).toHaveAttribute('aria-selected', 'true');
      const body = panel.getByRole('tabpanel');
      await expect(body.locator('[data-part="overall"]')).toContainText('Overall fit 87%');
      await expect(body.locator('[data-part="overall"]')).toContainText('scorer confidence 80%');
      await expect(body.locator('[data-match="verified"]')).toContainText('Related project of yours: u2');
      await expect(body.locator('[data-match="verified"]')).toContainText('Every form answer is supported by your facts');
      await expect(body.locator('[data-match="verified"] a')).toHaveAttribute('href', 'https://github.com/me/u2');
      await expect(body.locator('[data-match="unverified"]')).toContainText('No source for this claim is stored');
      await expect(body.locator('[data-match="gaps"]')).toContainText('No gap is confirmed by a rule');
      await expect(body.locator('progress, meter, [role="progressbar"]')).toHaveCount(0);
      await expect(body).toContainText('What this analysis cannot do yet');

      await panel.getByRole('tab', { name: 'Application' }).click();
      await expect(body.locator('[data-submit-box]')).toBeVisible();
      await expect(body).toContainText('Latest review: approved');
      await expect(body).toContainText('Resume: resume.pdf');
      await panel.getByRole('tab', { name: 'Company' }).click();
      await expect(body).toContainText('Rae <rae@example.com>');
      await expect(body).toContainText('does not store research about a company yet');
      await expect(body).toContainText('No company site is stored');
      await expect(body.locator('a[href^="javascript"]')).toHaveCount(0);
      const axe = await new AxeBuilder({ page }).include('u2-job-detail-panel').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    } finally { await context.close(); }
  });

  test('notes: saved as Markdown text, re-read when the tab opens, and a change made elsewhere is a conflict the owner reloads', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(1)}`);
    try {
      const writes = [];
      const state = await stub(page, { writes });
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await panel.getByRole('tab', { name: 'Notes' }).click();
      const area = panel.getByLabel('Notes (Markdown)');
      await expect(area).toHaveValue('');
      await expect(panel.getByRole('button', { name: 'Save notes' })).toBeDisabled();
      await area.fill('## Call\n- <b>ask</b> about team size');
      await panel.getByRole('button', { name: 'Save notes' }).click();
      await expect(panel.locator('[data-notes-part="message"]')).toContainText('Saved');
      expect(writes).toEqual([['notes', { body: '## Call\n- <b>ask</b> about team size', revision: null }]]);
      await expect(panel.locator('u2-job-notes b')).toHaveCount(0);

      // Edited elsewhere (in a text editor): the tab shows the file when it is opened again.
      Object.assign(state, { body: 'edited in an editor', revision: 'rev-editor', exists: true });
      await panel.getByRole('tab', { name: 'Overview' }).click();
      await panel.getByRole('tab', { name: 'Notes' }).click();
      await expect(area).toHaveValue('edited in an editor');

      // Edited elsewhere again while the owner is typing: saving is a conflict, nothing is overwritten.
      await area.fill('my newer thought');
      Object.assign(state, { body: 'changed under you', revision: 'rev-other' });
      await panel.getByRole('button', { name: 'Save notes' }).click();
      await expect(panel.getByRole('alert').filter({ hasText: 'changed since you opened it' })).toBeVisible();
      await expect(area).toHaveValue('my newer thought');
      expect(state.body).toBe('changed under you');
      await panel.getByRole('button', { name: 'Reload from file' }).click();
      await expect(area).toHaveValue('changed under you');
      await expect(panel.locator('[data-notes-part="conflict"]')).toHaveCount(0);

      // Unsaved text is saved on the way to another job.
      await area.fill('saved on leaving');
      await page.locator('tr[data-job]').nth(2).locator('td[data-col="location"]').click();
      await expect(panel.locator('[data-part="heading"]')).toHaveText('Engineer 3');
      await expect.poll(() => state.body).toBe('saved on leaving');
    } finally { await context.close(); }
  });

  test('actions use the existing endpoints: Mark not interested posts the status after a confirmation; approval stays two-step', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${id(3)}`);
    try {
      const posts = [];
      let job3 = { applications: [planned] };
      await stub(page, { jobs: new Proxy({}, { get: (_, key) => (Number(key) === 3 ? job3 : undefined) }) });
      await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}\/(status|approve-and-submit)$/, (route) => {
        const request = route.request();
        posts.push([request.url().split('/').at(-1), request.postDataJSON()]);
        if (request.url().endsWith('/status')) { job3 = { status: 'rejected', applications: [] }; return route.fulfill({ json: { changed: true } }); }
        job3 = { status: 'applied', applications: [{ ...planned, status: 'submitted', plan: { ...planned.plan, ready: false } }] };
        return route.fulfill({ json: { status: 'submitted', job: jobFor(3, job3) } });
      });
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      const primary = panel.locator('[data-detail-action="primary"]');
      await expect(primary).toHaveText('Review and approve');
      await primary.click();
      expect(posts).toEqual([]);
      await expect(panel.getByRole('tab', { name: 'Application' })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.getByRole('button', { name: 'Approve and submit…' })).toBeFocused();
      await expect(panel.getByRole('button', { name: 'Yes, submit this application' })).toHaveCount(0);
      await panel.getByRole('button', { name: 'Approve and submit…' }).click();
      expect(posts).toEqual([]);
      await panel.getByRole('button', { name: 'Yes, submit this application' }).click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toEqual(['approve-and-submit', { planHash: 'hash-3', confirm: true }]);
      await expect(panel.locator('[data-part="status"]')).toContainText('Applied');

      // Mark not interested: the menu, a confirmation, then the status endpoint only.
      job3 = {};
      await page.locator('tr[data-job]').first().locator('td[data-col="location"]').click();
      await page.locator('tr[data-job]').nth(2).locator('td[data-col="location"]').click();
      await expect(panel.locator('[data-part="heading"]')).toHaveText('Engineer 3');
      posts.length = 0;
      await panel.locator('summary').click();
      await panel.getByRole('button', { name: 'Mark not interested' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      expect(posts).toEqual([]);
      await panel.locator('summary').click();
      await panel.getByRole('button', { name: 'Mark not interested' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toEqual(['status', { status: 'rejected' }]);
      await expect(panel.locator('[data-part="status"]')).toContainText('Rejected');
    } finally { await context.close(); }
  });
});
