import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { writeRecord } from '../../mcp/jobs/ledger.js';
import { tinyPng } from '../helpers/png.js';

const PASSPHRASE = 'correct horse battery staple';
const PNG = tinyPng();

test('owner reviews job applications from the vault ledger', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const vault = path.join(dedicated._dataDir, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt', 'applications'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'applications', 'globex-form.png'), PNG);
  writeRecord(vault, { job_id: 'greenhouse:acme:101', company: 'Acme Corp', title: 'Senior Engineer', status: 'needs_answers',
    open_questions: [{ name: 'question_3', label: 'Are you authorized to work in the US?', options: ['Yes', 'No'] }] });
  writeRecord(vault, { job_id: 'lever:globex:abc-1', company: 'globex', title: 'Staff Engineer', status: 'applied', applied_at: new Date().toISOString(),
    url: 'https://jobs.lever.co/globex/abc-1', answered: { 'Best system you built?': 'A payments ledger.' }, screenshot: 'job-hunt/applications/globex-form.png' }, 'I build reliable systems.');
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${dedicated.baseURL}/#/applications`);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('.workspace__title', { hasText: 'Job applications' })).toBeVisible();
    await expect(page.locator('.application-card')).toHaveCount(2);

    const applied = page.locator('.application-card', { hasText: 'Staff Engineer' });
    await expect(applied).toContainText('Applied');
    await expect(applied.locator('a', { hasText: 'Posting' })).toHaveAttribute('href', 'https://jobs.lever.co/globex/abc-1');
    await applied.locator('summary', { hasText: 'What was sent' }).click();
    await expect(applied).toContainText('A payments ledger.');
    await expect(applied).toContainText('I build reliable systems.');
    const shot = applied.locator('img');
    await expect(shot).toHaveAttribute('alt', 'Filled form for Staff Engineer');
    await expect.poll(() => shot.evaluate((img) => img.complete && img.naturalWidth)).toBe(1);

    const pending = page.locator('.application-card', { hasText: 'Senior Engineer' });
    await expect(pending).toContainText('Needs answers');
    await expect(pending).toContainText('Are you authorized to work in the US? (Yes / No)');

    await page.locator('[data-filter="needs_answers"]').click();
    await expect(page.locator('.application-card')).toHaveCount(1);
    await expect(page.locator('[data-filter="needs_answers"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-filter=""]').click();
    await expect(page.locator('.application-card')).toHaveCount(2);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
