import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const id = (n) => `job_${String(n).padStart(16, '0')}`;

// #640: Agent Operations (#/job-hunt/operations) and contextual chat. The operations endpoint is stubbed so every figure on
// the page is known; the unknown-job case at the end talks to the real server.

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const row = (over) => ({ tool: 'jobs.send_application', label: 'Send application email', requestedBy: 'job-autopilot', jobId: id(1), company: 'Company 1', role: 'Engineer 1', ...over });
const OPERATIONS = {
  generatedAt: new Date().toISOString(),
  autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: ago(120_000), cycleRunning: true, lastCycle: { startedAt: ago(300_000), finishedAt: ago(120_000), mode: 'dry_run', actions: 3, needsYou: 1, errors: 1 }, settingsChangedAt: null },
  running: { count: 1, items: [row({ id: 'act_run', status: 'executing', tool: 'jobs.submit_application', label: 'Submit application form', attempts: 1, since: ago(60_000) })] },
  awaitingApproval: { count: 2, items: [row({ id: 'act_a', status: 'pending', since: ago(3_600_000) }), row({ id: 'act_b', status: 'pending', tool: 'email.send', label: 'Send email', jobId: null, company: null, role: null, since: ago(7_200_000) })] },
  recent: [row({ id: 'act_done', status: 'executed', at: ago(86_400_000) })],
  failures: [
    { source: 'autopilot', id: null, label: 'Autopilot cycle', status: 'error', at: ago(120_000), message: 'score: model timeout', jobId: null, company: null, role: null },
    row({ id: 'act_bad', source: 'action', status: 'failed', label: 'Submit application form', tool: 'jobs.submit_application', at: ago(900_000), message: 'The form changed unexpectedly' }),
  ],
  lastActivity: { autopilotCycleAt: ago(120_000), lastActionAt: ago(86_400_000), lastFailureAt: ago(120_000) },
};

const jobFor = (n) => ({
  id: id(n), company: `Company ${n}`, role: `Engineer ${n}`, status: 'qualified', locations: ['Oakland, CA'], remote: true, salary: null, technologies: [], contactEmails: [], applicationUrls: [], companyUrl: null,
  firstSeenAt: '2026-10-02T12:00:00.000Z', score: { score: 88, label: 'strong', confidence: 0.8, degraded: false, model: 'm', scoredAt: '2026-10-03T12:00:00.000Z', narrative: 'x', reasons: ['Overlap'], concerns: [], projects: [], flags: [] },
  dimensions: {}, strategy: { name: 'FORM', reason: 'r' }, draft: null, materials: [], emails: [], sources: [], events: [], applications: [], reviews: [], contacts: [], tasks: [], interviews: [], attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: true, apple_mail: false, apple_mail_draft: false },
});

async function signIn(browser, baseURL, hash) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  return { context, page };
}

test.describe.serial('job hunt agent operations and contextual chat (#640)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  test('shows autopilot state, approvals, running work and failures from the data, is accessible and has no controls', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/operations');
    try {
      const writes = [];
      page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${request.url()}`); });
      await page.route('**/api/job-hunt/operations', (route) => route.fulfill({ json: OPERATIONS }));
      await page.reload();
      await expect(page.locator('u2-job-operations h1')).toHaveText('Agent Operations');
      await expect(page.locator('u2-nav a[data-route="#/job-hunt/operations"]')).toHaveClass(/is-active/);
      await expect(page.locator('[data-part="mode"]')).toContainText('Dry run');
      await expect(page.locator('[data-part="execution"]')).toContainText('Running cycle');
      await expect(page.locator('[data-part="mode-note"]')).toContainText('sends nothing');
      await expect(page.locator('[data-part="approval-count"]')).toHaveText('2');
      await expect(page.getByRole('link', { name: 'Review in Operations' })).toHaveAttribute('href', '#/operations');
      const approvals = page.getByRole('region', { name: 'Awaiting your approval' });
      await expect(approvals.locator('li')).toHaveCount(2);
      await expect(approvals.getByRole('link', { name: 'Company 1 — Engineer 1' })).toHaveAttribute('href', `#/job-hunt/jobs/${id(1)}`);
      await expect(approvals.locator('li').nth(1)).toContainText('—');
      await expect(page.getByRole('region', { name: 'Running now' })).toContainText('Submit application form');
      const failures = page.getByRole('region', { name: 'Recent failures and errors' });
      await expect(failures).toContainText('score: model timeout');
      await expect(failures).toContainText('The form changed unexpectedly');
      await expect(page.getByRole('region', { name: 'Recent agent actions' })).toContainText('Done');
      await expect(page.locator('[data-part="last-action-at"]')).toHaveText('1d ago');

      // Read only: nothing on the page can change the autopilot, an approval or a policy.
      await expect(page.locator('u2-job-operations button, u2-job-operations input, u2-job-operations select, u2-job-operations form')).toHaveCount(0);
      const axe = await new AxeBuilder({ page }).include('u2-job-operations').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('updates on agent.action events, announces the change politely and sends no write', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/operations');
    try {
      let data = OPERATIONS;
      const writes = [];
      page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url()); });
      await page.route('**/api/job-hunt/operations', (route) => route.fulfill({ json: data }));
      await page.reload();
      await expect(page.locator('[data-part="approval-count"]')).toHaveText('2');
      const live = page.locator('u2-job-operations [data-part="live"]');
      await expect(live).toHaveAttribute('aria-live', 'polite');
      await expect(live).toHaveText('');
      data = { ...OPERATIONS, awaitingApproval: { count: 3, items: [row({ id: 'act_c', status: 'pending', since: ago(1000) }), ...OPERATIONS.awaitingApproval.items] } };
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.proposed' } })));
      await expect(page.locator('[data-part="approval-count"]')).toHaveText('3');
      await expect(live).toContainText('3 awaiting your approval');
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('a failed load explains itself and Try again recovers', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/operations');
    try {
      let fail = true;
      await page.route('**/api/job-hunt/operations', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'database is locked' } }) : route.fulfill({ json: OPERATIONS })));
      await page.reload();
      await expect(page.getByText("Couldn't load agent operations")).toBeVisible();
      fail = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('[data-part="approval-count"]')).toHaveText('2');
    } finally { await context.close(); }
  });

  test('Ask about this job attaches a removable chip, sends only the job id with each message, and removal is keyboard operable', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt/opportunities');
    try {
      const rows = [1, 2].map((n) => ({ id: id(n), company: `Company ${n}`, role: `Engineer ${n}`, locations: ['Oakland, CA'], remote: true, compensation: null, skills: [], status: 'qualified', stage: 'qualified', needsInput: false, fit: 88, fitLabel: 'strong', postedAt: null, firstSeenAt: '2026-10-02T12:00:00.000Z' }));
      await page.route('**/api/job-hunt/opportunities?**', (route) => route.fulfill({ json: { items: rows, total: 2, page: 1, limit: 25, counts: { all: 2, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 } } }));
      await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => route.fulfill({ json: jobFor(Number(route.request().url().slice(-16))) }));
      const sent = [];
      await page.route('**/api/agent/message', (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { response: `Reply ${sent.length}`, actions: [], conversationId: 'conv_fixture' } }); });
      await page.route('**/api/agent/conversations', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 201, json: { conversationId: 'conv_fixture' } }) : route.fulfill({ json: { conversations: [] } })));
      await page.reload();
      await page.locator('tr[data-job]').nth(0).locator('td[data-col="location"]').click();
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toHaveText('Engineer 1');
      await expect(page.locator('u2-agent-context')).toBeHidden();

      await page.getByRole('button', { name: 'Ask about this job' }).click();
      const chip = page.locator('u2-agent-context');
      await expect(chip.getByRole('group', { name: 'Job context attached to your messages' })).toContainText('Job context: Company 1 — Engineer 1');
      await expect(page.locator('.agent-panel__input')).toBeFocused();
      await expect(chip.locator('[role="status"]')).toContainText('Job context attached');

      for (const text of ['How good a fit is this?', 'And the risks?']) {
        await page.locator('.agent-panel__input').fill(text);
        await page.locator('.agent-panel__composer button[type="submit"]').click();
        await expect(page.locator('.chat-bubble.is-agent').last()).toContainText('Reply');
      }
      expect(sent.map((body) => body.context)).toEqual([{ kind: 'job', jobId: id(1) }, { kind: 'job', jobId: id(1) }]);
      expect(sent.every((body) => Object.keys(body.context).sort().join() === 'jobId,kind')).toBe(true);
      await expect(chip).toBeVisible();
      const axe = await new AxeBuilder({ page }).include('u2-agent-context').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

      // Keyboard: tab to the remove button and press Enter; focus returns to the composer.
      await page.getByRole('button', { name: 'Remove job context: Company 1 — Engineer 1' }).focus();
      await page.keyboard.press('Enter');
      await expect(chip).toBeHidden();
      await expect(page.locator('.agent-panel__input')).toBeFocused();
      await page.locator('.agent-panel__input').fill('A general question');
      await page.locator('.agent-panel__composer button[type="submit"]').click();
      await expect(page.locator('.chat-bubble.is-agent').last()).toContainText('Reply 3');
      expect(sent[2]).not.toHaveProperty('context');

      // Another job replaces the chip, and Delete on the focused chip removes it.
      await page.locator('tr[data-job]').nth(1).locator('td[data-col="location"]').click();
      await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toHaveText('Engineer 2');
      await page.getByRole('button', { name: 'Ask about this job' }).click();
      await expect(chip).toContainText('Company 2 — Engineer 2');
      await page.getByRole('button', { name: 'Remove job context: Company 2 — Engineer 2' }).focus();
      await page.keyboard.press('Delete');
      await expect(chip).toBeHidden();
    } finally { await context.close(); }
  });

  test('the real server refuses an unknown or malformed context with a 400 and does not ignore it', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/home');
    try {
      const result = await page.evaluate(async () => {
        const { sendAgentMessage } = await import('/services/api.js');
        const out = [];
        for (const ctx of [{ kind: 'job', jobId: 'job_ffffffffffffffff' }, { kind: 'job', jobId: 'nope' }, { kind: 'mail', jobId: 'x' }]) {
          try { await sendAgentMessage('hello', undefined, ctx); out.push('accepted'); } catch (error) { out.push(error.message); }
        }
        return out;
      });
      expect(result).toHaveLength(3);
      for (const message of result) expect(message).toMatch(/context/);
    } finally { await context.close(); }
  });
});
