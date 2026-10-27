import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

// #547: the "Needs you" filter on Job Leads lists form jobs (status needs_input, no email draft) and email jobs
// ranked beyond the list limit.

const view = (id, company, score, status, draft = null) => ({
  id, company, role: `Engineer at ${company}`, status, locations: ['San Francisco, CA'], remote: null, salary: null, technologies: [], contactEmails: [], applicationUrls: [],
  score: { score, label: 'strong', confidence: 0.9, degraded: false, narrative: 'AI/agent systems', reasons: [], concerns: [], projects: [], flags: [] },
  strategy: { name: draft ? 'DIRECT_EMAIL' : 'FORM_APPLICATION', reason: 'test' }, draft, materials: [], emails: [],
});

const RANKED = [view('j1', 'Alpha', 95, 'scored'), view('j2', 'FormCo', 90, 'needs_input')];
const WAITING = [view('j2', 'FormCo', 90, 'needs_input'), view('j3', 'DeepCo', 71, 'needs_input', { to: 'a@b.c', subject: 's', text: 't', attachments: [], needsInput: ['Visa status'] })];

test('Needs you lists form jobs and email jobs ranked beyond the limit', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    await page.route('**/api/job-hunt/jobs?**', async (route) => {
      const url = new URL(route.request().url());
      const jobs = url.searchParams.get('status') === 'needs_input' ? WAITING : RANKED;
      await route.fulfill({ json: { minimumScore: 70, counts: { scored: 2, needs_input: 2 }, jobs, sendRoutes: {} } });
    });
    await page.goto(`${dedicated.baseURL}/#/job-hunt/leads`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-job-hunt .workspace__title')).toHaveText('Job Leads');
    await page.getByRole('button', { name: 'Needs you' }).click();
    const cards = page.locator('u2-job-hunt article.application-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: 'FormCo' })).toContainText('The application form is waiting on you');
    await expect(cards.filter({ hasText: 'DeepCo' })).toContainText('Visa status');
    await expect(cards.filter({ hasText: 'Alpha' })).toHaveCount(0);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});

// #624: the sort control applies on every tab and is remembered.
test('Job Leads sorts on every tab and remembers the choice', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const page = await context.newPage();
    await page.route('**/api/job-hunt/jobs?**', (route) => route.fulfill({ json: { minimumScore: 70, counts: { scored: 3 }, jobs: [view('j1', 'Zeta', 95, 'scored'), view('j2', 'Alpha', 80, 'scored'), view('j3', 'Mid', 85, 'scored')], sendRoutes: {} } }));
    await page.goto(`${dedicated.baseURL}/#/job-hunt/leads`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await page.getByRole('button', { name: 'All scored' }).click();
    const names = () => page.locator('u2-job-hunt article.application-card .trigger-row__heading strong a').allTextContents();
    expect((await names()).map((t) => t.split(' at ')[1])).toEqual(['Zeta', 'Mid', 'Alpha']);
    await page.getByLabel('Sort by').selectOption('company');
    expect((await names()).map((t) => t.split(' at ')[1])).toEqual(['Alpha', 'Mid', 'Zeta']);
    await page.getByRole('button', { name: /Sort direction/ }).click();
    expect((await names()).map((t) => t.split(' at ')[1])).toEqual(['Zeta', 'Mid', 'Alpha']);
    await page.getByRole('button', { name: 'Strong (80+)' }).click();
    expect((await names()).map((t) => t.split(' at ')[1])).toEqual(['Zeta', 'Mid', 'Alpha'], 'the order holds on another tab');
    await page.reload();
    await expect(page.getByLabel('Sort by')).toHaveValue('company');
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
