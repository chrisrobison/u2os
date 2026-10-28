import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const NOTION = 'job_00000000000000a1';
const OPENAI = 'job_00000000000000a2';

// #629: the Job Hunt Overview at #/job-hunt. The overview endpoint is stubbed so every number on the page is known;
// the embedded pipeline board talks to the real (empty) server.

const stage = (id, label, statuses, count, flag = false) => ({ id, label, statuses, count, flag });
const OVERVIEW = {
  generatedAt: new Date().toISOString(), strongMatchScore: 80, minimumScore: 82, offPipeline: 4,
  metrics: [
    { id: 'discovered', label: 'Jobs discovered', value: 4059, sub: '+312 this week', filter: 'all', statuses: null },
    { id: 'strong', label: 'Strong matches', value: 186, sub: 'score 80 or higher', filter: 'strong', statuses: null },
    { id: 'attention', label: 'Need your attention', value: 2, sub: 'questions, reviews, decisions', filter: 'needs_input', statuses: null },
    { id: 'submitted', label: 'Applications submitted', value: 8, sub: '2 in the last 7 days', filter: null, statuses: ['applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'rejected'] },
    { id: 'responded', label: 'Employer responses', value: 2, sub: '1 in the last 7 days', filter: null, statuses: ['screening', 'interview', 'offer', 'rejected'] },
    { id: 'interviewing', label: 'Interviewing', value: 1, sub: 'active now', filter: null, statuses: ['interview'] },
  ],
  stages: [
    stage('discovered', 'Discovered', ['discovered', 'scored', 'researching'], 4000), stage('qualified', 'Qualified', ['qualified'], 42),
    stage('preparing', 'Preparing', ['materials_generated', 'applying', 'needs_input'], 12), stage('needs_input', 'Needs Input', [], 2, true),
    stage('submitted', 'Submitted', ['applied', 'contacted', 'followup_due'], 8), stage('responded', 'Responded', ['screening'], 2),
    stage('interviewing', 'Interviewing', ['interview'], 1), stage('offer', 'Offer', ['offer'], 0),
  ],
  attention: { count: 2, items: [
    { jobId: NOTION, company: 'Notion', role: 'Software Engineer, Developer Platform', status: 'needs_input', score: 90, kind: 'needs_answers', kinds: ['needs_answers'], explanation: '1 required question could not be answered', detail: null, action: null, severity: 1, urgency: 0, deadline: null, since: new Date(Date.now() - 2 * 3_600_000).toISOString(), question: { key: 'custom:why', label: 'Why are you interested?' } },
    { jobId: OPENAI, company: 'OpenAI', role: 'API Safety', status: 'needs_input', score: null, kind: 'blocked', kinds: ['blocked'], explanation: 'The form cannot be filled automatically', detail: null, action: null, severity: 2, urgency: 0, deadline: null, since: new Date(Date.now() - 4 * 3_600_000).toISOString(), question: null },
  ] },
  activity: [{ id: 9, at: new Date(Date.now() - 600_000).toISOString(), label: 'Application sent', tone: 'success', jobId: OPENAI, company: 'OpenAI', role: 'API Safety' }],
  autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: new Date(Date.now() - 120_000).toISOString() },
};

const detail = {
  id: NOTION, company: 'Notion', role: 'Software Engineer, Developer Platform', status: 'needs_input', locations: [], remote: null, salary: null, technologies: [], contactEmails: [], applicationUrls: [], companyUrl: null,
  firstSeenAt: '2026-10-01T00:00:00.000Z', score: { score: 90, label: 'strong', confidence: 0.9, degraded: false, narrative: null, reasons: [], concerns: [], projects: [], flags: [] }, strategy: { name: 'FORM_APPLICATION', reason: 'test' },
  draft: null, materials: [], emails: [], sources: [], events: [], contacts: [], tasks: [], interviews: [], reviews: [],
  applications: [{ id: 3, url: 'https://boards.example/notion/1', status: 'needs_input', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    plan: { ready: false, needs: [], blockers: [], unresolved: [{ key: 'custom:first', label: 'Preferred first name?', reason: 'unknown_required_field', required: true }, { key: 'custom:why', label: 'Why are you interested?', reason: 'unknown_required_field', required: true }], fields: [] },
    result: { outcome: null, reason: null, errors: [], at: null, screenshots: [] } }],
  attention: { needsYou: true, reasons: [{ kind: 'needs_answers', title: '2 required questions could not be answered', items: ['Preferred first name?: no answer', 'Why are you interested?: no answer'], action: 'Answer them.' }] },
};

async function signIn(browser, baseURL, hash) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/${hash}`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('input[name="passphrase"]')).toHaveCount(0);
  return { context, page };
}

test.describe.serial('job hunt overview (#629)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  test('shows the summary bar, distinct autopilot mode and status, the pipeline, the attention queue and activity, with the old board below', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await page.route('**/api/job-hunt/overview', (route) => route.fulfill({ json: OVERVIEW }));
      await page.reload();
      await expect(page.locator('u2-job-overview .jh-ov__top h1')).toHaveText('Job Hunt');

      const cards = page.locator('u2-job-overview jh-summary-card');
      await expect(cards).toHaveCount(6);
      await expect(cards.locator('.jh-summary-card__value')).toHaveText(['4,059', '186', '2', '8', '2', '1']);
      await expect(cards.nth(0)).toContainText('+312 this week');
      await expect(cards.nth(1)).toContainText('score 80 or higher');

      await expect(page.locator('[data-part="mode"]')).toContainText('Dry run');
      await expect(page.locator('[data-part="execution"]')).toContainText('Running cycle');
      await expect(page.getByRole('link', { name: 'Autopilot controls' })).toHaveAttribute('href', '#/job-hunt/leads');

      await expect(page.locator('.jh-ov__stage .jh-ov__stage-label')).toHaveText(['Discovered', 'Qualified', 'Preparing', 'Needs Input', 'Submitted', 'Responded', 'Interviewing', 'Offer']);
      await expect(page.locator('.jh-ov__stage .jh-ov__stage-count')).toHaveText(['4,000', '42', '12', '2', '8', '2', '1', '0']);
      await expect(page.locator('u2-job-overview')).toContainText('not an overlapping funnel');

      const notion = page.locator(`[data-job="${NOTION}"]`);
      await expect(notion).toContainText('Notion');
      await expect(notion).toContainText('Why are you interested?');
      await expect(notion).toContainText('90 fit');
      await expect(page.locator(`[data-job="${OPENAI}"]`)).toContainText('— ·');
      await expect(page.locator('[data-part="attention-count"]')).toHaveText('2');
      await expect(page.locator('.jh-ov__event')).toContainText('Application sent');

      const axe = await new AxeBuilder({ page }).include('.jh-ov__top').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

      // The previous board is still on the page.
      await expect(page.locator('u2-job-dashboard h1')).toBeVisible();
      // One nav entry for the Overview, no duplicate.
      await expect(page.locator('u2-nav a[href="#/job-hunt"]')).toHaveCount(1);
    } finally { await context.close(); }
  });

  test('Review opens the job and focuses the specific outstanding question', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      await page.route('**/api/job-hunt/overview', (route) => route.fulfill({ json: OVERVIEW }));
      await page.route(`**/api/job-hunt/jobs/${NOTION}`, (route) => route.fulfill({ json: detail }));
      await page.reload();
      await page.locator(`[data-job="${NOTION}"] [data-part="review"]`).click();
      await expect(page).toHaveURL(new RegExp(`#/job-hunt/jobs/${NOTION}\\?question=custom%3Awhy$`));
      await expect(page.locator('u2-job-page [data-needs-you]')).toBeVisible();
      await expect(page.locator('u2-job-page [data-key="custom:why"]')).toHaveAttribute('data-focused-question', '');
      await expect(page.locator('u2-job-page [data-key="custom:why"] input, u2-job-page [data-key="custom:why"] textarea, u2-job-page [data-key="custom:why"] select')).toBeFocused();
      await expect(page.locator('u2-job-page [data-key="custom:first"]')).not.toHaveAttribute('data-focused-question', '');
    } finally { await context.close(); }
  });

  test('metrics and stages open the Opportunities table with the matching query', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      const asked = [];
      const row = (id, status, fit) => ({ id, company: `Co ${id.slice(-2)}`, role: 'Engineer', locations: [], remote: null, compensation: null, skills: [], status, stage: null, needsInput: false, fit, fitLabel: null, postedAt: null, firstSeenAt: '2026-10-01T00:00:00.000Z' });
      await page.route('**/api/job-hunt/overview', (route) => route.fulfill({ json: OVERVIEW }));
      await page.route('**/api/job-hunt/opportunities?**', (route) => {
        const params = new URL(route.request().url()).searchParams;
        asked.push(Object.fromEntries(params.entries()));
        const items = params.get('min_score') ? [row('job_00000000000000b2', 'scored', 92)] : [row('job_00000000000000b1', 'applied', 85)];
        route.fulfill({ json: { items, total: items.length, page: 1, limit: 25, counts: { all: 3, needs_input: 0, ready: 0, applied: 1, responded: 0, archived: 0 } } });
      });
      await page.reload();

      await page.locator('jh-summary-card[data-metric="strong"] a').click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities\?min_score=80$/);
      await expect(page.locator('tr[data-job]')).toHaveCount(1);
      expect(asked.at(-1)).toMatchObject({ min_score: '80' });

      await page.goto(`${dedicated.baseURL}/#/job-hunt`);
      await page.locator('.jh-ov__stage[data-stage="submitted"] a').click();
      await expect(page).toHaveURL(/#\/job-hunt\/opportunities\?stage=submitted$/);
      await expect(page.locator('.jh-opp__chip[data-scope="stage"]')).toContainText('Submitted');
      await expect(page.locator('tr[data-job]')).toHaveCount(1);
      expect(asked.at(-1)).toMatchObject({ stage: 'submitted' });
    } finally { await context.close(); }
  });

  test('an error shows a retry, and a quiet store shows empty states', async ({ browser }) => {
    const { context, page } = await signIn(browser, dedicated.baseURL, '#/job-hunt');
    try {
      let fail = true;
      const empty = { ...OVERVIEW, metrics: OVERVIEW.metrics.map((m) => ({ ...m, value: 0 })), stages: OVERVIEW.stages.map((s) => ({ ...s, count: 0 })), attention: { count: 0, items: [] }, activity: [], autopilot: null, offPipeline: 0 };
      await page.route('**/api/job-hunt/overview', (route) => (fail ? route.fulfill({ status: 500, json: { error: 'database is locked' } }) : route.fulfill({ json: empty })));
      await page.reload();
      const error = page.locator('u2-job-overview jh-state[data-kind="error"]');
      await expect(error).toContainText("Couldn't load the overview");
      await expect(error).toContainText('database is locked');
      fail = false;
      await error.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('jh-state[data-kind="error"]')).toHaveCount(0);
      await expect(page.locator('u2-job-overview')).toContainText('Nothing needs you right now');
      await expect(page.locator('u2-job-overview')).toContainText('No activity yet');
      await expect(page.locator('u2-job-overview')).toContainText('No jobs yet');
      await expect(page.locator('jh-summary-card .jh-summary-card__value').first()).toHaveText('0');
      await expect(page.locator('[data-autopilot="unavailable"]')).toContainText('not available');
    } finally { await context.close(); }
  });
});
