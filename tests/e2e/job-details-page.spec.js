import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const ID = 'job_00000000000000aa';

// #559: clicking a listed job opens its details page, which says why the job needs the owner.

const listed = { id: ID, company: 'FormCo', role: 'Staff Engineer', status: 'needs_input', locations: ['San Francisco, CA'], remote: null, salary: null, technologies: [], contactEmails: [], applicationUrls: [], score: { score: 90, label: 'strong', confidence: 0.9, degraded: false, narrative: 'AI/agent systems', reasons: [], concerns: [], projects: [], flags: [] }, strategy: { name: 'FORM_APPLICATION', reason: 'test' }, draft: null, materials: [], emails: [] };
const detail = {
  ...listed, companyUrl: 'https://formco.example', firstSeenAt: '2026-10-01T00:00:00.000Z', technologies: ['Node'],
  applicationUrls: ['https://boards.example/formco/1'],
  score: { ...listed.score, reasons: ['Direct overlap'], concerns: ['On-site'] },
  sources: [{ source: 'greenhouse', author: null, url: null, postedAt: null, rawText: 'FormCo is hiring a Staff Engineer.' }],
  events: [{ id: 1, at: '2026-10-02T00:00:00.000Z', type: 'status_changed', fromStatus: null, toStatus: 'needs_input', detail: {} }],
  materials: [{ kind: 'resume_pdf', file: 'Pat_Resume.pdf' }],
  contacts: [], tasks: [], interviews: [],
  applications: [{ id: 7, url: 'https://boards.example/formco/1', status: 'needs_input', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    plan: { ready: false, needs: [], blockers: [], unresolved: [{ label: 'Security clearance?', reason: 'sensitive_never_inferred' }], fields: [{ label: 'First Name', required: true, origin: 'identity', value: 'Pat' }] },
    result: { outcome: 'unconfirmed', reason: null, errors: [], at: null, screenshots: ['application-7/run-a/form.png'] } }],
  reviews: [{ id: 3, kind: 'form', decision: 'reject', checks: [{ name: 'plan_ready', pass: false, detail: 'plan is needs_input' }], concerns: [{ severity: 'blocking', text: 'Clearance unanswered' }], notes: 'No.', model: 'm', createdAt: '2026-10-02T00:00:00.000Z' }],
  attention: { needsYou: true, reasons: [
    { kind: 'needs_answers', title: '1 required question could not be answered', items: ['Security clearance?: a sensitive question U2OS never answers for you'], action: 'Answer the standard ones once in job-hunt/answers.yaml, or fill the form in yourself.' },
    { kind: 'review_rejected', title: 'The review agent said no (form)', items: ['The application plan is not ready (plan is needs_input)', 'Clearance unanswered'], action: 'Fix the objections.' },
  ] },
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('a listed job opens its details page, which explains what is needed', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    await page.route('**/api/job-hunt/jobs?**', (route) => route.fulfill({ json: { minimumScore: 70, counts: { needs_input: 1 }, jobs: [listed], sendRoutes: {} } }));
    await page.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: detail }));
    await page.route(`**/api/job-hunt/jobs/${ID}/screenshot?**`, (route) => route.fulfill({ body: PNG, contentType: 'image/png' }));

    await page.goto(`${dedicated.baseURL}/#/job-hunt/leads`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('button', { name: 'Needs you' }).click();
    await page.getByRole('link', { name: 'Staff Engineer at FormCo' }).click();

    await expect(page).toHaveURL(new RegExp(`#/job-hunt/jobs/${ID}$`));
    const needs = page.locator('u2-job-page [data-needs-you]');
    await expect(needs).toContainText('1 required question could not be answered');
    await expect(needs).toContainText('Security clearance?');
    await expect(needs).toContainText('Clearance unanswered');
    await expect(page.locator('u2-job-page [data-review="3"]')).toContainText('Rejected');
    await expect(page.locator('u2-job-page [data-application="7"]')).toContainText('Security clearance?');
    await expect(page.locator('u2-job-page [data-application="7"] img')).toBeVisible();
    await expect(page.locator('u2-job-page')).toContainText('FormCo is hiring a Staff Engineer.');

    // The URL is shareable: a reload shows the same page.
    await page.reload();
    await expect(page.locator('u2-job-page [data-needs-you]')).toBeVisible();

    // Back returns to the list.
    await page.getByRole('link', { name: '← Job Leads' }).click();
    await expect(page).toHaveURL(/#\/job-hunt\/leads$/);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('an unknown job shows a plain message', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    await page.goto(`${dedicated.baseURL}/#/job-hunt/jobs/job_0000000000000000`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-job-page [role="alert"]')).toHaveText('There is no such job.');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('unanswered questions can be answered on the page, and the page updates after re-planning', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    const waiting = JSON.parse(JSON.stringify(detail));
    waiting.applications[0].plan.unresolved = [
      { key: 'clearance', label: 'Do you have a security clearance?', type: 'combobox', required: true, reason: 'sensitive_never_inferred', options: ['Yes', 'No'] },
      { key: 'scaled', label: 'Describe a system you scaled', type: 'text', required: true, reason: 'unknown_required_field' },
    ];
    const done = JSON.parse(JSON.stringify(waiting));
    done.applications[0].status = 'planned';
    done.applications[0].plan.unresolved = [];
    done.attention = { needsYou: false, reasons: [] };
    let sent = null;
    await page.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: waiting }));
    await page.route(`**/api/job-hunt/jobs/${ID}/answers`, async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { saved: 2, status: 'planned', unresolved: 0, job: done } });
    });
    await page.goto(`${dedicated.baseURL}/#/job-hunt/jobs/${ID}`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    const form = page.locator('u2-job-page [data-answer-form]');
    await expect(form).toBeVisible();
    await expect(form.locator('select option')).toHaveText(['Choose...', 'Yes', 'No']);
    await form.getByRole('button', { name: 'Save answers and re-plan' }).click();
    await expect(form.locator('[role="alert"]')).toHaveText('Type or choose at least one answer.');
    expect(sent).toBeNull();

    await form.getByLabel('Do you have a security clearance? *').selectOption('No');
    await form.getByLabel('Describe a system you scaled *').fill('A dispatch platform.');
    await form.getByRole('button', { name: 'Save answers and re-plan' }).click();
    await expect(page.locator('u2-job-page [data-needs-you]')).toHaveCount(0);
    await expect(page.locator('u2-job-page')).toContainText('Nothing is waiting on you for this job.');
    expect(sent).toEqual({ answers: [{ key: 'clearance', value: 'No' }, { key: 'scaled', value: 'A dispatch platform.' }] });
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
