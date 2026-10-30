import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const ID = `job_${String(1).padStart(16, '0')}`;

// #636: evidence resolution in the Match Analysis tab. The opportunities, job, evidence and rescore endpoints are stubbed with
// a small in-memory model of their contracts (the real ones are covered by tests/job-hunt-evidence.test.js), so the owner's
// path through the panel (question, answer, rescored result, pending and retry, accessibility) runs in a real browser.

const ROW = { id: ID, company: 'Company 1', role: 'Engineer 1', locations: ['Oakland, CA'], remote: true, compensation: '$180K', skills: ['Node'], status: 'qualified', stage: 'qualified', needsInput: false, fit: 74, fitLabel: 'plausible', postedAt: '2026-10-01T12:00:00.000Z', firstSeenAt: '2026-10-02T12:00:00.000Z' };
const QUESTIONS = [
  { key: 'dim:technical', kind: 'dimension', statement: 'Technical: Partial overlap with the stack', prompt: 'Can you back up the technical part of this match with your own experience?', source: 'Scorer' },
  { key: 'concern:0123456789ab', kind: 'concern', statement: 'No Go experience listed', prompt: 'Do you have experience or evidence that addresses this concern?', source: 'Scorer' },
];

function makeJob(state) {
  return {
    id: ID, company: 'Company 1', role: 'Engineer 1', status: 'qualified', locations: ['Oakland, CA'], remote: true, salary: '$180K - $220K', technologies: ['Node'], contactEmails: [], applicationUrls: [], companyUrl: null, firstSeenAt: '2026-10-02T12:00:00.000Z',
    score: { score: state.score, label: 'plausible', confidence: state.confidence, degraded: false, model: 'model-x', scoredAt: state.scoredAt, narrative: 'x', reasons: [], concerns: ['No Go experience listed'], projects: [], flags: [] },
    dimensions: { technical: { points: 9, max: 15, reason: 'Partial overlap with the stack' }, location: { points: 8, max: 10, reason: 'Remote, US-compatible' } },
    strategy: { name: 'FORM', reason: 'x' }, draft: null, materials: [], emails: [], sources: [], events: [], applications: [], reviews: [], contacts: [], tasks: [], interviews: [], attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: false, apple_mail: false, apple_mail_draft: false },
    evidence: { questions: QUESTIONS, answers: state.answers, lastAnsweredAt: state.answers.map((a) => a.at).sort().at(-1) ?? null, rescorePending: state.pending },
  };
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

test.describe.serial('job hunt evidence resolution (#636)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  async function stub(page, { modelUp }) {
    const state = { score: 74, confidence: 0.62, scoredAt: '2026-10-03T12:00:00.000Z', answers: [], pending: false };
    const posts = [];
    await page.route('**/api/job-hunt/opportunities?**', (route) => route.fulfill({ json: { items: [ROW], total: 1, page: 1, limit: 25, counts: { all: 1, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 } } }));
    await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: makeJob(state) }) : route.fallback()));
    const rescore = () => {
      if (!modelUp.value) return { status: 'pending', reason: 'No model is available right now.', previous: { score: state.score, confidence: state.confidence }, current: null };
      const previous = { score: state.score, confidence: state.confidence };
      Object.assign(state, { score: 81, confidence: 0.85, scoredAt: '2026-10-31T00:00:00.000Z', pending: false });
      return { status: 'done', previous, current: { score: 81, confidence: 0.85 } };
    };
    await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}\/evidence$/, (route) => {
      const sent = route.request().postDataJSON();
      posts.push(['evidence', sent]);
      const entry = { ...sent, label: QUESTIONS.find((q) => q.key === sent.key).statement, source: 'owner', job: ID, at: '2026-10-30T12:00:00.000Z' };
      state.answers = [...state.answers.filter((a) => a.key !== sent.key), entry];
      state.pending = true;
      const result = rescore();
      return route.fulfill({ json: { saved: entry, changed: true, rescore: result, job: makeJob(state) } });
    });
    await page.route(/\/api\/job-hunt\/jobs\/job_\d{16}\/rescore$/, (route) => {
      posts.push(['rescore', route.request().postDataJSON()]);
      const result = rescore();
      return route.fulfill({ json: { rescore: result, job: makeJob(state) } });
    });
    return { state, posts };
  }

  test('answer Yes: the item moves to Verified as "Stated by you", the score is rescored and the result is announced', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${ID}`);
    try {
      const { posts } = await stub(page, { modelUp: { value: true } });
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await panel.getByRole('tab', { name: 'Match Analysis' }).click();
      const body = panel.getByRole('tabpanel');
      const unverified = body.locator('[data-match="unverified"]');
      await expect(unverified).toContainText('Technical: Partial overlap with the stack');
      await unverified.locator('li[data-key="dim:technical"] summary').click();
      const group = unverified.getByRole('group', { name: 'Can you back up the technical part of this match with your own experience?' });
      await expect(group.getByRole('radio')).toHaveCount(3);

      const axe = await new AxeBuilder({ page }).include('u2-job-detail-panel').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

      // Saving without a choice asks for one and sends nothing.
      await unverified.locator('li[data-key="dim:technical"]').getByRole('button', { name: 'Save and rescore' }).click();
      await expect(unverified.getByRole('alert').filter({ hasText: 'Choose Yes, No or Partly.' })).toBeVisible();
      expect(posts).toEqual([]);

      await group.getByLabel('Yes, I can back this up').check();
      await unverified.locator('li[data-key="dim:technical"]').getByLabel(/Details \(optional/).fill('Four years of Go services');
      await unverified.locator('li[data-key="dim:technical"]').getByRole('button', { name: 'Save and rescore' }).click();

      const result = body.locator('[data-part="rescore"]');
      await expect(result).toHaveText('Rescored. Fit 74% → 81%; scorer confidence 62% → 85%.');
      await expect(result).toHaveAttribute('role', 'status');
      await expect(result).toBeFocused();
      expect(posts).toEqual([['evidence', { key: 'dim:technical', answer: 'yes', detail: 'Four years of Go services' }]]);
      const verified = body.locator('[data-match="verified"]');
      await expect(verified).toContainText('Technical: Partial overlap with the stack');
      await expect(verified).toContainText('Source: Stated by you');
      await expect(verified).toContainText('Yes, stated by you on Oct 30, 2026');
      await expect(verified).toContainText(`Recorded in job-hunt/evidence/${ID}.md as dim:technical`);
      await expect(verified).toContainText('Your detail: Four years of Go services');
      await expect(unverified).not.toContainText('Technical: Partial overlap');
      await expect(panel.locator('[data-part="fit"]')).toHaveText('81% fit');
      const after = await new AxeBuilder({ page }).include('u2-job-detail-panel').analyze();
      expect(after.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    } finally { await context.close(); }
  });

  test('answer No: a confirmed gap because the owner said so; no model: the answer stays, an alert explains and Retry rescored it', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, `#/job-hunt/opportunities?job=${ID}`);
    try {
      const modelUp = { value: false };
      const { posts } = await stub(page, { modelUp });
      await page.reload();
      const panel = page.locator('u2-job-detail-panel');
      await panel.getByRole('tab', { name: 'Match Analysis' }).click();
      const body = panel.getByRole('tabpanel');
      const item = body.locator('[data-match="unverified"] li[data-key="concern:0123456789ab"]');
      await item.locator('summary').click();
      await item.getByLabel('No, this is a gap').check();
      await item.getByRole('button', { name: 'Save and rescore' }).click();

      const alert = body.locator('[data-part="rescore"]');
      await expect(alert).toHaveAttribute('role', 'alert');
      await expect(alert).toContainText('Saved, but not rescored yet: No model is available right now. Fit stays 74%, scorer confidence 62%.');
      await expect(alert).toBeFocused();
      const gaps = body.locator('[data-match="gaps"]');
      await expect(gaps).toContainText('No Go experience listed');
      await expect(gaps).toContainText('A gap because you said so.');
      await expect(gaps).toContainText('Source: Stated by you');
      await expect(panel.locator('[data-part="fit"]')).toHaveText('74% fit');

      // A reload still knows the score is out of date, and Retry works once a model is available.
      await page.reload();
      await panel.getByRole('tab', { name: 'Match Analysis' }).click();
      await expect(body.locator('[data-part="rescore"]')).toContainText('not reflected in the score yet');
      modelUp.value = true;
      await body.getByRole('button', { name: 'Retry rescore' }).click();
      await expect(body.locator('[data-part="rescore"]')).toHaveText('Rescored. Fit 74% → 81%; scorer confidence 62% → 85%.');
      await expect(body.getByRole('button', { name: 'Retry rescore' })).toHaveCount(0);
      expect(posts.map(([kind]) => kind)).toEqual(['evidence', 'rescore']);
    } finally { await context.close(); }
  });
});
