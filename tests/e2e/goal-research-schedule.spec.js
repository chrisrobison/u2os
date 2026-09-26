import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('finite research status survives reload and pause/resume stops future passes without model work', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    let calls = 0;
    dedicated.handle.agent.planner.modelRouter = null;
    dedicated.handle.agent.planner.modelProvider = { id: 'fixture', destination: 'local_model', plan: async () => { calls++; throw new Error('future wake must not plan'); } };
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await goals.locator('.goal-job-draft').click();
    await goals.locator('[name="constraints"]').fill('Remote senior research engineer. No outreach.');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-message')).toContainText('No work has started');
    await page.evaluate(async () => {
      const api = await import('/services/api.js');
      const goal = (await api.listGoalDrafts()).goals[0];
      await api.scheduleGoalResearch(goal.id, { expectedRevision: goal.revision,
        fireAt: new Date(Date.now() + 3600_000).toISOString(), intervalHours: 24, maxPasses: 3 });
    });
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Finite research schedule');
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('1/3 passes scheduled · 0 confirmed successful read passes (not goal completion)');
    await expect(goals.locator('.goal-schedule-save')).toBeDisabled();
    await goals.locator('[data-goal-control="pause"]').click();
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('Research schedule cancelled');
    await goals.locator('[data-goal-control="resume"]').click();
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Manual only · Next wake-up: none · Spent: 0 runs');
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('Research schedule cancelled');
    await expect(goals.locator('.goal-schedule-save')).toBeEnabled();
    expect(calls).toBe(0);
  } finally { await stopDedicatedServer(page, dedicated); }
});
