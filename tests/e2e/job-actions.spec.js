import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const ID = 'job_00000000000000bb';

// The job page's action bar: Apply Online, Apply via Email, Prepare Email, Answer Questions, Reject.

const base = {
  id: ID, company: 'MailCo', role: 'Staff Engineer', status: 'qualified', locations: ['Remote'], remote: true, salary: null, technologies: [],
  contactEmails: ['jobs@mailco.example'], applicationUrls: ['https://boards.example/mailco/1'], companyUrl: 'https://mailco.example', firstSeenAt: '2026-10-01T00:00:00.000Z',
  score: { score: 90, label: 'strong', confidence: 0.9, degraded: false, narrative: 'x', reasons: [], concerns: [], projects: [], flags: [] },
  strategy: { name: 'DIRECT_EMAIL', reason: 'test' }, draft: null, materials: [], emails: [], sources: [], events: [], contacts: [], tasks: [], interviews: [], applications: [], reviews: [],
  attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: true, apple_mail: true, apple_mail_draft: true },
};

async function open(browser, dedicated, routes) {
  const context = await browser.newContext();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const page = await context.newPage();
  await routes(page);
  await page.goto(`${dedicated.baseURL}/#/job-hunt/jobs/${ID}`);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  return { page, context };
}

test('Prepare Email saves a draft, Apply via Email confirms first and then sends, and the buttons explain when they are off', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  let context;
  try {
    const calls = [];
    let current = base;
    let page;
    ({ context, page } = await open(browser, dedicated, async (page) => {
      await page.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: current }));
      await page.route(`**/api/job-hunt/jobs/${ID}/email`, async (route) => {
        const { mode } = route.request().postDataJSON();
        calls.push(mode);
        current = { ...current, emails: [{ id: 1, kind: mode === 'draft' ? 'draft' : 'application', to: 'jobs@mailco.example', status: mode === 'draft' ? 'drafted' : 'sent', updatedAt: '2026-10-12T00:00:00.000Z' }] };
        await route.fulfill({ json: { mode, via: 'apple_mail', status: 'executed', actionId: 'a1', email: { id: 1, to: 'jobs@mailco.example', status: 'x' }, job: current } });
      });
    }));
    const bar = page.locator('u2-job-actions');
    await expect(bar.getByRole('button', { name: 'Apply Online' })).toBeEnabled();
    await expect(bar.getByRole('button', { name: 'Answer Questions' })).toBeDisabled();

    await bar.getByRole('button', { name: 'Prepare Email' }).click();
    await expect(bar.locator('[data-action-notice]')).toContainText('Saved to the Drafts folder in Apple Mail');
    expect(calls).toEqual(['draft']);
    await expect(bar.getByRole('button', { name: 'Prepare Email' })).toBeDisabled();

    await bar.getByRole('button', { name: 'Apply via Email' }).click();
    await expect(page.locator('[data-confirm-dialog]')).toContainText('jobs@mailco.example');
    expect(calls).toEqual(['draft']);
    await page.locator('[data-confirm-dialog]').getByRole('button', { name: 'Cancel' }).click();
    expect(calls).toEqual(['draft'], 'cancel sends nothing');
    await bar.getByRole('button', { name: 'Apply via Email' }).click();
    await page.locator('[data-confirm-dialog] [data-confirm]').click();
    await expect(bar.locator('[data-action-notice]')).toContainText('Sent to jobs@mailco.example');
    expect(calls).toEqual(['draft', 'send']);
    await expect(bar.getByRole('button', { name: 'Apply via Email' })).toBeDisabled();
  } finally {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('Answer Questions opens a modal, saves the answers and the page shows the re-planned job', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  let context;
  try {
    const waiting = { ...base, status: 'needs_input', applications: [{ id: 5, url: 'https://boards.example/mailco/1', status: 'needs_input', planHash: 'h', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
      plan: { ready: false, needs: [], blockers: [], fields: [], unresolved: [
        { key: 'scaled', label: 'Describe a system you scaled', type: 'text', required: true },
        { label: 'Do you have a clearance?', reason: 'sensitive_never_inferred' }] },
      result: { outcome: null, reason: null, errors: [], at: null, screenshots: [] } }] };
    const done = { ...waiting, applications: [{ ...waiting.applications[0], status: 'planned', plan: { ...waiting.applications[0].plan, unresolved: [{ label: 'Do you have a clearance?', reason: 'sensitive_never_inferred' }] } }] };
    let sent = null;
    let page;
    ({ context, page } = await open(browser, dedicated, async (p) => {
      await p.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: waiting }));
      await p.route(`**/api/job-hunt/jobs/${ID}/answers`, async (route) => { sent = route.request().postDataJSON(); await route.fulfill({ json: { saved: 1, status: 'planned', unresolved: 0, job: done } }); });
    }));
    await page.locator('u2-job-actions').getByRole('button', { name: 'Answer Questions (1)' }).click();
    const dialog = page.locator('[data-answers-dialog]');
    await expect(dialog).toContainText('1 sensitive question U2OS never answers for you');
    await dialog.getByRole('button', { name: 'Save answers and re-plan' }).click();
    await expect(dialog.locator('[role="alert"]')).toHaveText('Type or choose at least one answer.');
    await dialog.getByLabel('Describe a system you scaled *').fill('A dispatch platform.');
    await dialog.getByRole('button', { name: 'Save answers and re-plan' }).click();
    expect(sent).toEqual({ answers: [{ key: 'scaled', value: 'A dispatch platform.' }] });
    await expect(dialog).toHaveCount(0, { timeout: 5000 }).catch(() => {});
    await expect(page.locator('u2-job-actions').getByRole('button', { name: 'Answer Questions' })).toBeDisabled();
  } finally {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  }
});

test('Reject asks first, then moves the job; Apply Online plans the form', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  let context;
  try {
    const moved = [];
    let plans = 0;
    let current = base;
    let page;
    ({ context, page } = await open(browser, dedicated, async (p) => {
      await p.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: current }));
      await p.route(`**/api/job-hunt/jobs/${ID}/status`, async (route) => { moved.push(route.request().postDataJSON().status); current = { ...current, status: 'rejected' }; await route.fulfill({ json: { changed: true } }); });
      await p.route(`**/api/job-hunt/jobs/${ID}/plan`, async (route) => { plans += 1; await route.fulfill({ status: 409, json: { error: 'No model is available to write the materials.' } }); });
    }));
    const bar = page.locator('u2-job-actions');
    await bar.getByRole('button', { name: 'Apply Online' }).click();
    await expect(bar.locator('[role="alert"]')).toContainText('No model is available');
    expect(plans).toBe(1);

    await bar.getByRole('button', { name: 'Reject' }).click();
    await page.locator('[data-confirm-dialog]').getByRole('button', { name: 'Cancel' }).click();
    expect(moved).toEqual([]);
    await bar.getByRole('button', { name: 'Reject' }).click();
    await page.locator('[data-confirm-dialog] [data-confirm]').click();
    await expect(bar.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(moved).toEqual(['rejected']);
  } finally {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  }
});
