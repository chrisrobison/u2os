import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('a delayed goal run continues after browser closure and exposes grounded evidence on return', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  const worker = dedicated.handle.agent.actionQueueWorker;
  const processAction = worker.processAction.bind(worker);
  const processNext = worker.processNext.bind(worker);
  let deliveries = 0; let calls = 0;
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    const agent = dedicated.handle.agent;
    agent.planner.modelRouter = null;
    agent.planner.modelProvider = { id: 'fixture', destination: 'local_model', plan: async (context) => {
      calls++;
      if (!context.observations.length) return { reasoning_summary: 'Research', continue: true,
        actions: [{ tool: 'web.search', arguments: { query: 'remote research roles' } }] };
      return { reasoning_summary: 'Report actual evidence', actions: [],
        response: `Observed role: ${context.observations[0].items[0].data.results[0].title}` };
    } };
    dedicated.handle.toolRegistry.get('web.search').execute = async () => {
      deliveries++; return { mock: true, results: [{ title: 'Fixture research role', url: 'https://example.test/role', snippet: 'Remote research' }] };
    };
    worker.processAction = async (id) => worker._currentOutcome(id);
    worker.processNext = async () => null;
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await goals.locator('[name="objective"]').fill('Research remote roles');
    await goals.locator('[name="criteria"]').fill('Report results with evidence');
    await goals.locator('[name="domain"][value="web"]').check();
    await goals.locator('[type="submit"]').click();
    await goals.locator('.goal-run').click();
    await expect(goals.locator('.goal-evidence')).toContainText('waiting_for_action');
    const goalId = await goals.locator('.goal-list__item').getAttribute('data-goal-id');
    const db = dedicated.handle.auth.db;
    const { id: runId } = db.prepare('SELECT id FROM agent_runs WHERE goal_id = ?').get(goalId);
    expect(calls).toBe(1); expect(deliveries).toBe(0);
    await page.goto('about:blank');
    worker.processAction = processAction; worker.processNext = processNext;
    await expect.poll(() => db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId).status).toBe('completed');
    expect(calls).toBe(2); expect(deliveries).toBe(1);
    await page.goto(dedicated.baseURL);
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    await goals.locator('.goal-runs__item').click();
    await expect(goals.locator('.goal-evidence')).toContainText('Observed role: Fixture research role');
    await expect(goals.locator('.goal-evidence')).toContainText('not verified completion');
    await expect(goals.locator('.goal-research-update')).toContainText('1 new links in indexed evidence');
  } finally {
    worker.processAction = processAction; worker.processNext = processNext;
    await stopDedicatedServer(page, dedicated);
  }
});
