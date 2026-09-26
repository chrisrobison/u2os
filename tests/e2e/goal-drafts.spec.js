import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('owner edits durable goal drafts without claiming work has started', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  let releaseInitialList = () => {};
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    const initialList = new Promise((resolve) => { releaseInitialList = resolve; });
    let firstList = true;
    await page.route('**/api/goals', async (route) => {
      if (route.request().method() === 'GET' && firstList) { firstList = false; await initialList; }
      await route.continue();
    });
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await expect(goals).toContainText('No automatic goal work is scheduled');
    await expect(goals.locator('[name="objective"]')).toBeDisabled();
    releaseInitialList();
    await expect(goals.locator('[name="objective"]')).toBeEnabled();
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
  } finally { releaseInitialList(); await stopDedicatedServer(page, dedicated); }
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
    await expect(goals.locator('.goal-evidence')).toContainText('objective unverified');
    await expect(goals.locator('.goal-run')).toBeHidden();
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 1 runs');
    await expect(goals.locator('.goal-runs')).toContainText('objective unverified');
    await goals.locator('.goal-runs__item').click();
    await expect(goals.locator('.goal-evidence')).toContainText('objective unverified');
    const runId = (await goals.locator('.goal-runs__item').textContent()).match(/Inspect run (\S+)/)[1];
    await page.route('**/api/goals/*/runs/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      runId, status: 'completed', objectiveStatus: 'unverified', response: '<script>bad()</script>', responseTruncated: false,
      stepsTruncated: false, steps: [{ index: 0, tool: 'web.search', status: 'executed', actionId: 'act_fixture',
        resultPreview: '{"title":"<img src=x onerror=bad()>"}', resultTruncated: false }],
    }) }));
    await goals.locator('.goal-runs__item').click();
    await expect(goals.locator('.goal-evidence')).toContainText('<script>bad()</script>');
    await expect(goals.locator('.goal-evidence')).toContainText('<img src=x onerror=bad()>');
    await expect(goals.locator('.goal-evidence script, .goal-evidence img')).toHaveCount(0);
    await goals.locator('[data-goal-control="pause"]').click();
    await expect(goals.locator('.goal-form__title')).toContainText('Paused');
    await expect(goals.locator('.goal-run')).toBeHidden();
    await expect(goals.locator('[name="objective"]')).toBeEnabled();
    await goals.locator('[name="objective"]').fill('Revised research scope');
    await goals.locator('[name="domain"][value="web"]').uncheck();
    await goals.locator('[name="domain"][value="email"]').check();
    await goals.getByRole('button', { name: 'Save revised goal' }).click();
    await expect(goals.locator('.goal-message')).toContainText('Goal remains paused');
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 1 runs');
    await page.reload();
    await expect(goals.locator('[name="objective"]')).toHaveValue('Revised research scope');
    await expect(goals.locator('[name="domain"][value="email"]')).toBeChecked();
    await expect(goals.locator('.goal-form__title')).toContainText('Paused');
    await page.unroute('**/api/goals/*/runs/*');
    await goals.locator('.goal-runs__item').click();
    await expect(goals.locator('.goal-evidence')).toContainText('Original goal revision 1');
    await expect(goals.locator('.goal-evidence')).toContainText('Find suitable research roles');
    await goals.locator('[data-goal-control="resume"]').click();
    await expect(goals.locator('.goal-message')).toContainText('No work automatically started');
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 1 runs');
    await goals.locator('[data-goal-control="cancel"]').click();
    await expect(goals.locator('.goal-form__title')).toContainText('Cancelled');
    await expect(goals.locator('.goal-controls')).toBeHidden();
    await page.reload();
    await expect(goals.locator('.goal-form__title')).toContainText('Cancelled');
    await expect(goals.locator('.goal-runs')).toContainText('objective unverified');
  } finally { await stopDedicatedServer(page, dedicated); }
});
