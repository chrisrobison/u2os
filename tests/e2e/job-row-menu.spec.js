import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';
const ID = 'job_00000000000000cc';

// #622: every listing on Job Leads has icon buttons (Open and pre-fill, Reject) and a "..." menu with the other actions.

const detail = (status = 'scored') => ({
  id: ID, company: 'RowCo', role: 'Staff Engineer', status, locations: ['Remote'], remote: true, salary: null, technologies: [],
  contactEmails: [], applicationUrls: ['https://boards.example/rowco/1'], companyUrl: null, firstSeenAt: '2026-10-01T00:00:00.000Z',
  score: { score: 90, label: 'strong', confidence: 0.9, degraded: false, narrative: 'x', reasons: [], concerns: [], projects: [], flags: [] },
  strategy: { name: 'FORM_APPLICATION', reason: 'test' }, draft: null, materials: [], emails: [], sources: [], events: [], contacts: [], tasks: [], interviews: [], applications: [], reviews: [],
  attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: false, apple_mail: false, apple_mail_draft: false },
});
const { sendRoutes, attention, sources, events, contacts, tasks, interviews, applications, reviews, ...summary } = detail();

test('a Job Leads listing rejects in two clicks and pre-fills without submitting', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    let current = detail();
    const moved = [];
    let prefills = 0;
    await page.route('**/api/job-hunt/jobs?**', (route) => route.fulfill({ json: { minimumScore: 70, counts: { scored: 1 }, jobs: [{ ...summary, status: current.status }], sendRoutes: {} } }));
    await page.route(`**/api/job-hunt/jobs/${ID}`, (route) => route.fulfill({ json: current }));
    await page.route(`**/api/job-hunt/jobs/${ID}/status`, async (route) => { moved.push(route.request().postDataJSON().status); current = detail('rejected'); await route.fulfill({ json: { changed: true } }); });
    await page.route(`**/api/job-hunt/jobs/${ID}/prefill`, async (route) => { prefills += 1; await route.fulfill({ json: { status: 'prefilled', company: 'RowCo', role: 'Staff Engineer', job: current } }); });
    await page.goto(`${dedicated.baseURL}/#/job-hunt/leads`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('button', { name: 'All scored' }).click();

    const card = page.locator('u2-job-hunt article.application-card');
    const menu = card.locator('u2-job-menu');
    await expect(menu.getByRole('button', { name: /Open and pre-fill the application for Staff Engineer at RowCo/ })).toBeEnabled();

    await menu.getByRole('button', { name: /Open and pre-fill/ }).click();
    await expect(page.locator('u2-job-hunt > .load-error[role="status"]')).toContainText('Nothing was sent');
    expect(prefills).toBe(1);

    await menu.getByRole('button', { name: /More actions/ }).click();
    const popover = menu.getByRole('menu');
    await expect(popover.getByRole('menuitem', { name: 'Open job page' })).toBeVisible();
    await expect(popover.getByRole('menuitem', { name: 'Apply via email' })).toBeDisabled();
    await expect(popover.getByRole('menuitem', { name: 'Apply via email' })).toHaveAttribute('title', 'This listing has no email address.');
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await menu.getByRole('button', { name: /^Reject / }).click();
    await page.locator('[data-confirm-dialog]').getByRole('button', { name: 'Cancel' }).click();
    expect(moved).toEqual([]);
    await menu.getByRole('button', { name: /^Reject / }).click();
    await page.locator('[data-confirm-dialog] [data-confirm]').click();
    await expect.poll(() => moved).toEqual(['rejected']);
    await expect(card.locator('.trigger-state', { hasText: 'rejected' })).toBeVisible();
    await expect(card.locator('u2-job-menu').getByRole('button', { name: /^Reject / })).toBeDisabled();
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
