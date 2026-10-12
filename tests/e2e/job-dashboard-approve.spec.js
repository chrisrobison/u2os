import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { seedHuntStore } from '../helpers/job-hunt-dashboard-seed.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';

const PASSPHRASE = 'correct horse battery staple';

// #574: a card with a planned, ready application has an Approve button on the dashboard board.
// The server, the board and the job detail are real; only the final submit is mocked, so nothing is sent.

const plan = (n, over = {}) => ({
  jobId: 'x', url: `https://boards.example/${n}`, schemaHash: 's', unresolved: [], blockers: [], needs: [], ready: true, planHash: `${n}`.repeat(64).slice(0, 64),
  fields: [{ key: 'name', label: 'Legal name', type: 'text', required: true, value: 'Pat Example', origin: 'identity' }], ...over,
});

test('Approve on a ready card opens a dialog that asks again before anything is sent', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  const context = await browser.newContext();
  try {
    await createOwner(dedicated.baseURL, PASSPHRASE);
    const vault = path.join(dedicated._dataDir, 'vault');
    const ids = seedHuntStore(vault);
    const store = openStore(huntDbPath(vault));
    const ready = plan(1);
    store.addApplication(ids['saved-1'], { url: ready.url, status: 'planned', plan: ready, idempotencyKey: 'k1' });
    store.addReview(ids['saved-1'], { kind: 'form', decision: 'reject', contentHash: 'h', checks: [], concerns: [{ severity: 'blocking', text: 'The URL could not be verified' }], notes: 'No.', model: 'm' });
    store.addApplication(ids['saved-2'], { url: 'https://boards.example/2', status: 'needs_input', plan: plan(2, { ready: false, unresolved: [{ key: 'q', label: 'Clearance?', reason: 'sensitive_never_inferred' }] }), idempotencyKey: 'k2' });
    store.close();

    const page = await context.newPage();
    const posts = [];
    await page.route('**/api/job-hunt/jobs/*/approve-and-submit', async (route) => {
      posts.push(route.request().postDataJSON());
      const job = await (await route.fetch({ url: route.request().url().replace('/approve-and-submit', ''), method: 'GET', headers: { ...route.request().headers() } })).json();
      job.applications[0].status = 'submitted';
      await route.fulfill({ json: { status: 'submitted', company: 'Acme Robotics', role: 'Staff Engineer', job } });
    });
    await page.goto(`${dedicated.baseURL}/#/job-hunt`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();

    // Only the ready card has the button.
    const approveButtons = page.locator('u2-job-pipeline .jh-card__approve');
    await expect(approveButtons).toHaveCount(1);
    await expect(approveButtons).toHaveAccessibleName('Approve Staff Engineer at Acme Robotics');
    await expect(page.locator('u2-job-pipeline .jh-card', { hasText: 'Northwind' }).locator('xpath=..').locator('.jh-card__approve')).toHaveCount(0);

    // The click opens the dialog and sends nothing.
    await approveButtons.click();
    const dialog = page.locator('dialog.jh-approve-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Approve: Staff Engineer at Acme Robotics');
    await expect(dialog.locator('[data-submit-box]')).toContainText('Legal name');
    await expect(dialog.locator('[data-override]')).toContainText('The URL could not be verified');
    expect(posts).toHaveLength(0);

    // Closing is possible before anything is sent, and Escape closes it too.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await approveButtons.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.jh-approve-dialog')).toHaveCount(0);

    // Approve, then the explicit second click.
    await approveButtons.click();
    await page.locator('dialog.jh-approve-dialog').getByRole('button', { name: 'Approve and submit…' }).click();
    await expect(page.locator('dialog.jh-approve-dialog')).toContainText('It cannot be undone.');
    expect(posts).toHaveLength(0);
    await page.locator('dialog.jh-approve-dialog').getByRole('button', { name: 'Yes, submit this application' }).click();
    await expect(page.locator('dialog.jh-approve-dialog [data-submit-notice]')).toHaveText('Submitted to Acme Robotics. The board showed its confirmation.');
    expect(posts).toEqual([{ planHash: ready.planHash, confirm: true }]);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
