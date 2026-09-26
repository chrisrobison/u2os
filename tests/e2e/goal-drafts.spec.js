import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('owner edits durable goal drafts without claiming work has started', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await expect(goals).toContainText('No automatic goal work is scheduled');
    await goals.locator('[name="objective"]').fill('Find <script>evil()</script> research roles');
    await goals.locator('[name="criteria"]').fill('Report three relevant open roles with links');
    await goals.locator('[name="constraints"]').fill('Remote or Bay Area only');
    await goals.locator('[name="domain"][value="web"]').check();
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-message')).toContainText('Draft saved. No work has started.');
    await expect(goals.locator('.goal-list__item')).toHaveCount(1);
    await expect(goals.locator('script')).toHaveCount(0);
    const id = await goals.locator('.goal-list__item').getAttribute('data-goal-id');
    await page.reload();
    await expect(goals.locator('.goal-list__item')).toContainText('<script>evil()</script>');
    await expect(goals.locator('[name="objective"]')).toHaveValue('Find <script>evil()</script> research roles');
    await goals.locator('[name="objective"]').fill('Find safe research roles');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-form__title')).toContainText('revision 2');
    await page.evaluate(async (goalId) => {
      const api = await import('/services/api.js');
      await api.updateGoalDraft(goalId, { objective: 'Another tab revision', completionCriteria: ['Report three relevant open roles with links'],
        constraints: ['Remote or Bay Area only'], permittedScope: { domains: ['web'], consequentialActions: false },
        budgets: { maxRuns: 10, maxModelCalls: 20, maxTokens: 50000 }, expectedRevision: 2 });
    }, id);
    await goals.locator('[name="objective"]').fill('Unsaved stale edit');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-message')).toContainText('Reload the saved draft');
    await goals.locator('.goal-reload').click();
    await expect(goals.locator('[name="objective"]')).toHaveValue('Another tab revision');
    await expect(goals).toContainText('Manual only · Next wake-up: none · Spent: 0 runs, 0 model calls, 0 reported tokens');
  } finally { await stopDedicatedServer(page, dedicated); }
});

test('owner invokes one read-only goal run and sees durable spending without a completion claim', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await goals.locator('[name="objective"]').fill('Find suitable research roles');
    await goals.locator('[name="criteria"]').fill('Report relevant roles with links');
    await goals.locator('[name="domain"][value="web"]').check();
    await goals.locator('[name="maxRuns"]').fill('1');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-run')).toBeVisible();
    await goals.locator('.goal-run').click();
    await expect(goals.locator('.goal-message')).toContainText('objective is not automatically verified');
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 1 runs');
    await expect(goals.locator('.goal-runs')).toContainText('objective unverified');
    await expect(goals.locator('.goal-run')).toBeHidden();
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 1 runs');
    await expect(goals.locator('.goal-runs')).toContainText('objective unverified');
  } finally { await stopDedicatedServer(page, dedicated); }
});
