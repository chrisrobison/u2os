import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

test('job research starter makes no writes and two bounded passes retain grounded evidence and reviews', async ({ page }) => {
  const dedicated = await startDedicatedServer();
  try {
    await createOwner(dedicated.baseURL, 'correct horse battery staple');
    const plannerContexts = [];
    let searches = 0;
    const roles = [
      { title: 'Fixture Atlas research engineer', url: 'https://jobs.example.test/atlas', snippet: 'Remote research engineer; senior experience preferred. Posting date unavailable.' },
      { title: 'Fixture Birch analyst', url: 'https://jobs.example.test/birch', snippet: 'On-site analyst in London. Experience requirements unavailable.' },
      { title: 'Fixture Cedar research engineer', url: 'https://jobs.example.test/cedar', snippet: 'Remote senior research engineer. Posting date unavailable.' },
    ];
    const agent = dedicated.handle.agent;
    agent.planner.modelRouter = null;
    agent.planner.modelProvider = { id: 'fixture', destination: 'local_model', plan: async (context, objective) => {
      plannerContexts.push(context);
      expect(objective).toContain('Remote only');
      expect(objective).toContain('Senior research engineer');
      if (!context.observations?.length) return { reasoning_summary: 'Search explicit owner criteria', continue: true,
        actions: [{ tool: 'web.search', arguments: { query: 'remote senior research engineer opportunities' } }] };
      const observed = context.observations[0].items[0].data.results;
      const reviews = context.priorReadArtifacts.flatMap((artifact) => artifact.ownerReviewContext?.reviews || []);
      const lines = observed.map((role) => {
        const review = reviews.find((item) => item.url === role.url && item.appliesToCurrentRevision);
        return `${role.title} (${role.url}): source excerpt: "${role.snippet}". ${role.snippet.startsWith('Remote')
          ? 'Candidate fit: remote research role; verify experience and availability.' : 'Does not meet remote-only constraint.'}${review ? ` Prior owner review: ${review.reviewStatus}; not a fresh discovery.` : ''}`;
      });
      return { reasoning_summary: 'Explain source evidence, not confirmed openings', actions: [],
        response: `${lines.join('\n')}\nFixture search coverage only; current availability not verified. No applications or outreach performed.` };
    } };
    dedicated.handle.toolRegistry.get('web.search').execute = async () => ({ mock: true,
      results: ++searches === 1 ? roles.slice(0, 2) : [roles[0], roles[2]] });
    await page.goto(dedicated.baseURL);
    await page.getByLabel('Passphrase').fill('correct horse battery staple');
    await page.locator('form button[type="submit"]').click();
    await page.locator('u2-nav a[data-route="#/goals"]').click();
    const goals = page.locator('u2-goals');
    await expect(goals.locator('.goal-job-draft')).toBeEnabled();
    const writes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/goals') && request.method() !== 'GET') writes.push(request.url());
    });
    await goals.locator('.goal-job-draft').click();
    await expect(goals.locator('.goal-message')).toContainText('Nothing is saved or started yet');
    await expect(goals.locator('[name="domain"]:checked')).toHaveCount(1);
    await expect(goals.locator('[name="domain"][value="web"]')).toBeChecked();
    await expect(goals.locator('[name="consequentialActions"]')).not.toBeChecked();
    await expect(goals.locator('.goal-list__item')).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(searches).toBe(0);
    expect(plannerContexts).toEqual([]);
    await goals.locator('[name="constraints"]').fill('Senior research engineer\nRemote only\nResearch only. No applications or outreach.');
    await goals.locator('[name="maxRuns"]').fill('2');
    await goals.locator('[type="submit"]').click();
    await expect(goals.locator('.goal-message')).toContainText('No work has started');
    expect(searches).toBe(0);
    await goals.locator('.goal-run').click();
    const evidence = goals.locator('.goal-evidence');
    await expect(evidence).toContainText('Candidate fit: remote research role');
    await expect(evidence).toContainText('Does not meet remote-only constraint');
    await expect(evidence).toContainText('current availability not verified');
    await expect(evidence).toContainText('objective unverified');
    await expect(goals.locator('.goal-research-update')).toContainText('2 new links in indexed evidence');
    const atlas = goals.locator('.goal-finding').filter({ has: page.locator('a[href="https://jobs.example.test/atlas"]') });
    await atlas.getByRole('button', { name: 'Mark relevant', exact: true }).click();
    await expect(atlas.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await page.reload();
    await expect(goals.locator('[name="constraints"]')).toHaveValue('Senior research engineer\nRemote only\nResearch only. No applications or outreach.');
    await expect(atlas.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await goals.locator('.goal-run').click();
    await expect(evidence).toContainText('Prior owner review: relevant; not a fresh discovery');
    await expect(evidence).toContainText('Fixture Cedar research engineer');
    await expect(goals.locator('.goal-research-update')).toContainText('1 new links in indexed evidence · 1 seen before');
    await expect(goals.locator('.goal-research-new')).toHaveCount(1);
    await expect(goals.locator('.goal-research-new')).toContainText('Cedar');
    await expect(goals.locator('.goal-findings .goal-finding')).toHaveCount(3);
    await expect(goals.locator('.goal-form__state')).toContainText('Spent: 2 runs, 4 model calls');
    await expect(goals.locator('.goal-run')).toBeHidden();
    expect(searches).toBe(2);
    expect(plannerContexts).toHaveLength(4);
    await goals.locator('[data-goal-control="pause"]').click();
    // Clicking does not await the asynchronous state write. Reload only
    // after the UI confirms the persisted pause, not while it can be aborted.
    await expect(goals.locator('.goal-message')).toContainText('Goal paused. New work stopped');
    await page.reload();
    await expect(goals.locator('.goal-form__title')).toContainText('Paused');
    await expect(goals.locator('.goal-runs__item')).toHaveCount(2);
    await expect(goals.locator('.goal-run')).toBeHidden();
    await expect(atlas.getByRole('button', { name: 'Mark relevant', exact: true })).toBeDisabled();
    await goals.locator('.goal-runs__item').first().click();
    await expect(evidence).toContainText('objective unverified');
    expect(searches).toBe(2);
    // Starting another unsaved template never overwrites the stored paused goal.
    await goals.locator('.goal-job-draft').click();
    await expect(goals.locator('.goal-form__title')).toHaveText('New job research draft');
    await goals.locator('.goal-list__item').click();
    await expect(goals.locator('.goal-form__title')).toContainText('Paused');
    await expect(goals.locator('[name="constraints"]')).toHaveValue('Senior research engineer\nRemote only\nResearch only. No applications or outreach.');
  } finally { await stopDedicatedServer(page, dedicated); }
});
