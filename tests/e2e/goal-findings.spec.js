import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('goal search findings deduplicate and retain owner review without rendering provider markup', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    const agent = dedicated.handle.agent;
    const goalContexts = [];
    agent.planner.modelRouter = null;
    agent.planner.modelProvider = { id: 'fixture', destination: 'local_model', plan: async (context) => {
      goalContexts.push(context.priorReadArtifacts);
      return { reasoning_summary: 'Search roles', actions: [{ tool: 'web.search', arguments: { query: 'remote research roles' } }] };
    } };
    dedicated.handle.toolRegistry.get('web.search').execute = async () => ({ mock: true, results: [
      { title: '<script>bad()</script> Research role', snippet: '<img src=x onerror=bad()> Remote opportunity', url: 'https://example.test/role?id=2&utm_source=fixture' },
      { title: 'Duplicate', snippet: 'Same role', url: 'https://example.test/role?utm_source=two&id=2' },
      { title: 'Unsafe', snippet: 'Not a link', url: 'javascript:bad()' },
    ] });
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await goals.locator('[name="objective"]').fill('Research remote roles');
    await goals.locator('[name="criteria"]').fill('Review suitable opportunities');
    await goals.locator('[name="domain"][value="web"]').check();
    await goals.locator('[name="maxRuns"]').fill('2');
    await goals.locator('[type="submit"]').click();
    await goals.locator('.goal-run').click();
    const panel = goals.locator('.goal-findings');
    await expect(panel.locator('.goal-finding')).toHaveCount(1);
    await expect(panel).toContainText('relevance and availability not verified');
    await expect(panel).toContainText('seen in 1 searches');
    await expect(panel).toContainText('Demo result');
    await expect(panel).toContainText('<img src=x onerror=bad()>');
    await expect(panel.locator('script, img')).toHaveCount(0);
    await expect(panel.locator('a')).toHaveAttribute('href', 'https://example.test/role?id=2');
    await expect(panel.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    await panel.getByRole('button', { name: 'Mark relevant', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await goals.locator('.goal-run').click();
    await expect(panel).toContainText('seen in 2 searches');
    expect(goalContexts[0]).toEqual([]);
    expect(goalContexts[1][0].goalRevision).toBe(1);
    expect(goalContexts[1][0].items[0].data.results[0].title).toContain('Research role');
    await expect(panel.locator('.goal-finding')).toHaveCount(1);
    await page.reload();
    await expect(panel).toContainText('seen in 2 searches');
    await expect(panel).toContainText('reviewed under goal revision 1');
    await expect(panel.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 480, height: 900 });
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.evaluate(async () => {
      const api = await import('/services/api.js');
      const id = document.querySelector('u2-goals .goal-list__item').dataset.goalId;
      await api.controlGoal(id, 'pause', 1);
      await api.controlGoal(id, 'resume', 2);
    });
    await panel.getByRole('button', { name: 'Dismiss finding', exact: true }).click();
    await expect(goals.locator('.goal-message')).toContainText('Goal changed; reload before reviewing');
    await page.reload();
    await expect(panel.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Dismiss finding', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Dismiss finding', exact: true })).toBeDisabled();
  } finally { await stopDedicatedServer(page, dedicated); }
});
