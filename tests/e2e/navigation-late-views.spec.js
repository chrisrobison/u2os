import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function login(page, server) {
  await createOwner(server.baseURL, 'fixture-only late view owner'); await page.goto(server.baseURL);
  await page.getByLabel('Passphrase').fill('fixture-only late view owner'); await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
  return page.evaluate(async () => (await (await fetch('/api/memory/entities?type=Person&query=Sarah')).json()).entities[0].id);
}
async function operations(page) {
  await page.locator('u2-nav a[data-route="#/operations"]').click(); await expect(page.locator('u2-operations .operations-summary')).toBeVisible();
}
const views = [
  ['calendar', '_renderCalendar', '**/api/calendar/events*'], ['tasks', '_renderTasks', '**/api/tasks*'],
  ['memory', '_renderMemory', '**/api/memory/entities'], ['projects', '_renderEntityList', '**/api/memory/entities?type=Project'],
  ['detail', '_renderEntityDetail', null],
];
for (const [view, method, url] of views) for (const outcome of ['success', 'failure']) {
  test(`late ${view} ${outcome} cannot replace selected Operations`, async ({ page }) => {
    const server = await startDedicatedServer(), reached = deferred(), release = deferred();
    try {
      const id = await login(page, server);
      await page.locator('u2-app').evaluate((app, method) => {
        const original = app[method].bind(app); app[method] = (...args) => original(...args).finally(() => { window.fixtureLateViewSettled = true; });
      }, method);
      await page.route(url || `**/api/memory/entities/${id}`, async (route) => {
        const response = outcome === 'success' ? await route.fetch() : null; reached.resolve(); await release.promise;
        await route.fulfill(response ? { response } : { status: 503, json: { error: 'fixture-private-old-view-error' } });
      });
      await page.evaluate((hash) => { location.hash = hash; }, view === 'detail' ? `#/memory/${id}` : `#/${view}`); await reached.promise;
      await operations(page); release.resolve(); await expect.poll(() => page.evaluate(() => window.fixtureLateViewSettled)).toBe(true);
      await expect(page.locator('u2-operations')).toBeVisible(); await expect(page.locator('#workspace')).not.toContainText('fixture-private-old-view-error');
    } finally { release.resolve(); await stopDedicatedServer(page, server); }
  });
}

test('detached root discards a late entity detail and preserves newer working drafts', async ({ page }) => {
  const server = await startDedicatedServer(), reached = deferred(), release = deferred();
  try {
    const id = await login(page, server);
    await page.locator('u2-app').evaluate((app) => {
      const render = app._renderEntityDetail.bind(app); app._renderEntityDetail = (...args) => render(...args).finally(() => { window.fixtureDetachedSettled = true; });
    });
    await page.route(`**/api/memory/entities/${id}`, async (route) => { const response = await route.fetch(); reached.resolve(); await release.promise; await route.fulfill({ response }); });
    await page.evaluate((id) => { location.hash = `#/memory/${id}`; }, id); await reached.promise;
    await page.locator('u2-app').evaluate((app) => { window.fixtureDetachedApp = app; app._memoryDrafts = new Map([['newer-draft', 'Owner working value']]); app.remove(); });
    release.resolve(); await expect.poll(() => page.evaluate(() => window.fixtureDetachedSettled)).toBe(true);
    expect(await page.evaluate(() => window.fixtureDetachedApp._memoryDrafts.get('newer-draft'))).toBe('Owner working value');
    expect(await page.evaluate(() => window.fixtureDetachedApp._workspace.textContent)).toContain('Loading');
  } finally { release.resolve(); await stopDedicatedServer(page, server); }
});

for (const operation of ['preview', 'delete', 'fact']) {
  test(`late memory ${operation} cannot prompt, redirect or reopen an old view`, async ({ page }) => {
    const server = await startDedicatedServer(), reached = deferred(), release = deferred();
    let dialogs = 0, writes = 0;
    try {
      const id = await login(page, server); await page.evaluate((id) => { location.hash = `#/memory/${id}`; }, id);
      await expect(page.locator('.workspace__title')).toContainText('Sarah');
      page.on('dialog', async (dialog) => { dialogs++; await dialog.accept(); });
      const target = operation === 'fact' ? '**/api/memory/facts/*' : operation === 'preview' ? `**/api/memory/entities/${id}/deletion-preview` : `**/api/memory/entities/${id}`;
      await page.route(target, async (route) => {
        if (operation === 'delete' && route.request().method() !== 'DELETE') return route.continue();
        if (operation === 'fact' && route.request().method() !== 'PATCH') return route.continue();
        const response = await route.fetch(); if (route.request().method() !== 'GET') writes++;
        reached.resolve(); await release.promise; await route.fulfill({ response });
      });
      const responseSettled = page.waitForResponse((response) => operation === 'fact' ? response.request().method() === 'PATCH' && response.url().includes('/api/memory/facts/') : response.url().endsWith(operation === 'preview' ? '/deletion-preview' : `/${id}`) && response.request().method() === (operation === 'preview' ? 'GET' : 'DELETE'));
      if (operation === 'fact') {
        const row = page.locator('.fact-row').filter({ has: page.locator('[data-correct]') }).first();
        await row.locator('[data-correct] input').fill('Owner correction from late view fixture'); await row.locator('[data-correct] button').click();
      } else await page.getByRole('button', { name: 'Delete Person', exact: true }).click();
      await reached.promise; await operations(page);
      await page.locator('u2-app').evaluate((app) => { app._memoryDrafts = new Map([['newer-draft', 'Keep newer value']]); window.fixtureMemoryApp = app;
        const current = app._isCurrentRoute.bind(app); app._isCurrentRoute = (...args) => { const result = current(...args); if (!result) window.fixtureOldCallbackStopped = true; return result; }; });
      release.resolve(); const response = await responseSettled; await response.finished();
      expect(response.status()).toBe(200);
      await expect.poll(() => page.evaluate(() => window.fixtureOldCallbackStopped)).toBe(true);
      await expect(page.locator('u2-operations')).toBeVisible(); await expect(page).toHaveURL(/#\/operations$/);
      expect(dialogs).toBe(operation === 'delete' ? 1 : 0); expect(writes).toBe(operation === 'preview' ? 0 : 1);
      expect(await page.evaluate(() => window.fixtureMemoryApp._memoryDrafts.get('newer-draft'))).toBe('Keep newer value');
    } finally { release.resolve(); await stopDedicatedServer(page, server); }
  });
}
