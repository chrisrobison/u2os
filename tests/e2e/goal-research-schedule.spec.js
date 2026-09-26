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
    const firstWake = await page.evaluate(() => {
      const time = new Date(Date.now() + 3600_000);
      return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    });
    await goals.locator('[name="wakeAt"]').fill(firstWake);
    await goals.locator('[name="researchIntervalHours"]').fill('24');
    await goals.locator('[name="researchPasses"]').fill('3');
    await goals.locator('.goal-research-schedule-save').click();
    await expect(goals.locator('.goal-message')).toContainText('No work started now');
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Finite research schedule');
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('1/3 passes scheduled · 0 confirmed successful read passes (not goal completion)');
    await expect(goals.locator('.goal-schedule-save')).toBeDisabled();
    await expect(goals.locator('.goal-research-schedule-save')).toBeDisabled();
    await page.setViewportSize({ width: 480, height: 900 });
    await expect.poll(() => goals.locator('.goal-schedule').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await goals.locator('[data-goal-control="pause"]').click();
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('Research schedule cancelled');
    await goals.locator('[data-goal-control="resume"]').click();
    await page.reload();
    await expect(goals.locator('.goal-form__state')).toContainText('Manual only · Next wake-up: none · Spent: 0 runs');
    await expect(goals.locator('.goal-research-schedule-status')).toContainText('Research schedule cancelled');
    await expect(goals.locator('.goal-schedule-save')).toBeEnabled();
    await expect(goals.locator('.goal-research-schedule-save')).toBeEnabled();
    expect(calls).toBe(0);
  } finally { await stopDedicatedServer(page, dedicated); }
});

test('native research scheduling rejects invalid and unsaved input, stale scope, mixed domains and insufficient pass budgets', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await goals.locator('.goal-job-draft').click();
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-message')).toContainText('Draft saved');
    const wake = await page.evaluate(() => {
      const time = new Date(Date.now() + 3600_000);
      return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    });
    await goals.locator('[name="wakeAt"]').fill(wake);
    let requests = 0;
    page.on('request', (request) => { if (request.url().endsWith('/research-schedule')) requests++; });
    await goals.locator('[name="researchIntervalHours"]').fill('23');
    await goals.locator('.goal-research-schedule-save').click();
    await expect(goals.locator('.goal-message')).toContainText('24–720 hours and 2–10 passes');
    expect(requests).toBe(0);
    await goals.locator('[name="researchIntervalHours"]').fill('24');
    await goals.locator('[name="constraints"]').fill('Unsaved remote-only preferences');
    await goals.locator('.goal-research-schedule-save').click();
    await expect(goals.locator('.goal-message')).toContainText('Save goal edits before scheduling');
    expect(requests).toBe(0);
    await goals.locator('.goal-reload').click();
    await expect(goals.locator('[name="constraints"]')).not.toHaveValue('Unsaved remote-only preferences');
    await page.evaluate(async () => {
      const api = await import('/services/api.js');
      const goal = (await api.listGoalDrafts()).goals[0];
      await api.updateGoalDraft(goal.id, { objective: goal.objective, completionCriteria: goal.completionCriteria,
        constraints: ['Different owner tab'], permittedScope: goal.permittedScope, budgets: goal.budgets, expectedRevision: goal.revision });
    });
    await goals.locator('.goal-research-schedule-save').click();
    await expect(goals.locator('.goal-message')).toContainText('Reload the saved goal before scheduling');
    expect(requests).toBe(1);
    const stored = await page.evaluate(async () => (await (await import('/services/api.js')).listGoalDrafts()).goals[0]);
    expect(stored.researchSchedule).toBeNull();
    expect(stored.constraints).toEqual(['Different owner tab']);
    expect(stored.spent.runs).toBe(0);
    await goals.locator('.goal-reload').click();
    await goals.locator('[name="domain"][value="email"]').check();
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-research-controls')).toBeHidden();
    await goals.locator('[name="domain"][value="email"]').uncheck();
    await goals.locator('[name="maxRuns"]').fill('1');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-research-controls')).toBeVisible();
    await expect(goals.locator('.goal-research-schedule-save')).toBeDisabled();
    await expect(goals.locator('.goal-research-schedule-note')).toContainText('At most 1 passes fit');
    expect(requests).toBe(1);
  } finally { await stopDedicatedServer(page, dedicated); }
});
