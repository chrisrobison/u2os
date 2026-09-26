import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

const passphrase = 'fixture-only saved approval passphrase';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const account = { providerId: 'gmail', instanceId: 'fixture_original', label: 'Original fixture account' };
const pending = (id = 'fixture_saved', label = account.label) => ({ items: [{ id, actionId: id, tool: 'email.send', status: 'waiting_approval', attemptCount: 0, account: { ...account, label } }], counts: { waiting_approval: 1 } });
const proposal = (id = 'fixture_saved', body = 'Saved fixture body') => ({ id, tool: 'email.send', status: 'pending', arguments: { to: 'recipient@example.test', subject: 'Saved fixture subject', body }, accountBinding: account });
async function withPage(page, operation, mode = 'personal') {
  const dedicated = await startDedicatedServer({ mode });
  try {
    await createOwner(dedicated.baseURL, passphrase); await page.goto(dedicated.baseURL); await page.getByLabel('Passphrase').fill(passphrase);
    await page.locator('form button[type="submit"]').click(); await expect(page.locator('#workspace u2-dashboard')).toBeVisible();
    await operation(dedicated);
  } finally { await stopDedicatedServer(page, dedicated); }
}
async function operations(page) { await page.locator('u2-nav a[data-route="#/operations"]').click(); await expect(page.getByRole('button', { name: 'Refresh operations', exact: true })).toBeVisible(); }
const refreshEvent = (page) => page.evaluate(() => window.dispatchEvent(new CustomEvent('u2-event', { detail: { type: 'agent.action.queue_updated' } })));

test('a real demo pending proposal is rediscovered after reload and can be rejected through unchanged runtime approval', async ({ page }) => withPage(page, async (dedicated) => {
  await page.locator('.agent-panel__input').fill('Move my 2 PM meeting with Sarah to tomorrow afternoon.');
  await page.locator('.agent-panel__composer button[type="submit"]').click();
  const inline = page.locator('.approval-list u2-approval').last(); await expect(inline).toHaveAttribute('data-status', 'pending');
  const original = await inline.evaluate((element) => element.action); let detailRequests = 0;
  await page.route(`${dedicated.baseURL}/api/actions/${original.id}`, (route) => { detailRequests++; return route.continue(); });
  await page.reload(); await expect(page.locator('.agent-panel__input')).toBeVisible();
  await operations(page); await expect(page.getByRole('button', { name: 'Review approval', exact: true })).toBeVisible(); expect(detailRequests).toBe(0);
  await page.getByRole('button', { name: 'Review approval', exact: true }).click();
  const reviewed = page.locator('.operation-review u2-approval'); await expect(reviewed).toHaveAttribute('data-status', 'pending'); expect(detailRequests).toBe(1);
  expect(await reviewed.evaluate((element) => element.action.arguments)).toEqual(original.arguments);
  expect(await reviewed.evaluate((element) => element.action.accountBinding)).toEqual(original.accountBinding);
  await reviewed.locator('[data-action="reject"]').click(); await expect(reviewed.locator('.u2-approval__status')).toHaveText('Cancelled');
  await expect(page.locator('.operations-count[data-status="waiting_approval"]')).toHaveText('Waiting for approval: 0');
  expect(await page.evaluate(async (id) => (await (await fetch(`/api/actions/${id}`)).json()).status, original.id)).toBe('rejected');
}, 'demo'));

test('lazy original proposal and in-flight uncertainty card survive metadata SSE refresh without payload disclosure or duplicate approval', async ({ page }) => withPage(page, async () => {
  let metadata = pending(), details = 0, approvals = 0; const reached = deferred(), release = deferred();
  await page.route('**/api/actions/operations', (route) => route.fulfill({ json: metadata }));
  await page.route('**/api/actions/fixture_saved', (route) => { details++; return route.fulfill({ json: proposal() }); });
  await page.route('**/api/actions/fixture_saved/approve', async (route) => { approvals++; reached.resolve(); await release.promise; await route.fulfill({ json: { status: 'failed', errorClass: 'outcome_uncertain', error: 'fixture-private-provider-error' } }); });
  await operations(page); await expect(page.getByRole('button', { name: 'Review approval', exact: true })).toBeVisible(); expect(details).toBe(0);
  await expect(page.locator('u2-operations')).not.toContainText('recipient@example.test'); await expect(page.locator('u2-operations')).not.toContainText('Saved fixture body');
  await page.getByRole('button', { name: 'Review approval', exact: true }).click(); const reviewed = page.locator('.operation-review u2-approval');
  await expect(reviewed).toContainText('Original fixture account (gmail)'); await expect(reviewed).toContainText('recipient@example.test'); await expect(reviewed).toContainText('Saved fixture body');
  await reviewed.evaluate((element) => { window.fixtureReviewedCard = element; });
  await reviewed.locator('[data-action="approve"]').click(); await reached.promise; await expect(reviewed.locator('[data-action="approve"]')).toBeDisabled();
  metadata = { items: [{ ...pending().items[0], status: 'failed', attemptCount: 1, errorClass: 'outcome_uncertain', activeAccount: 'Other fixture account' }], counts: { failed: 1 } };
  await refreshEvent(page); await expect(page.locator('.operation-card__meta')).toHaveText('outcome uncertain · 1 attempt');
  expect(await reviewed.evaluate((element) => element === window.fixtureReviewedCard)).toBe(true); await expect(reviewed.locator('[data-action="approve"]')).toBeDisabled();
  release.resolve(); await expect(reviewed.locator('.u2-approval__status')).toHaveText('Outcome uncertain'); await expect(reviewed).toContainText('no automatic retry');
  expect(details).toBe(1); expect(approvals).toBe(1); await expect(reviewed).not.toContainText('Other fixture account'); await expect(reviewed).not.toContainText('fixture-private');
  await expect(reviewed.locator('[data-action]')).toHaveCount(0); await page.getByRole('button', { name: 'Close preview (does not cancel action)', exact: true }).click();
  await expect(page.locator('.operation-review')).toBeHidden(); expect(approvals).toBe(1);
}));

test('stale identity/status, missing account and private HTTP errors cannot expose saved approval controls', async ({ page }) => withPage(page, async () => {
  let response; await page.route('**/api/actions/operations', (route) => route.fulfill({ json: pending('fixture_bad') }));
  await page.route('**/api/actions/fixture_bad', (route) => route.fulfill(response)); await operations(page);
  for (const [value, notice] of [
    [{ json: proposal('other_identity', 'fixture-private-mismatched-body') }, /no longer has a verified pending approval/],
    [{ json: { ...proposal('fixture_bad', 'fixture-private-completed-body'), status: 'executed' } }, /no longer has a verified pending approval/],
    [{ json: { ...proposal('fixture_bad'), accountBinding: null } }, /Original account identity is unavailable/],
    [{ status: 404, json: { error: 'fixture-private-server-error' } }, /Couldn't load the saved approval/],
  ]) {
    response = value; await page.getByRole('button', { name: 'Review approval', exact: true }).click();
    await expect(page.locator('.operation-review')).toContainText(notice); await expect(page.locator('.operation-review u2-approval')).toHaveCount(0);
    await expect(page.locator('.operation-review')).not.toContainText('fixture-private');
  }
}));

test('metadata refresh is single-flight and skips a superseded snapshot instead of rendering stale waiting work', async ({ page }) => withPage(page, async () => {
  const first = deferred(), second = deferred(), releaseFirst = deferred(), releaseSecond = deferred(); let requests = 0, active = 0, maxActive = 0;
  await page.route('**/api/actions/operations', async (route) => {
    requests++; active++; maxActive = Math.max(maxActive, active); const index = requests;
    if (index === 1) { first.resolve(); await releaseFirst.promise; } else { second.resolve(); await releaseSecond.promise; }
    active--; await route.fulfill({ json: index === 1 ? pending('fixture_stale') : { items: [], counts: {} } });
  });
  await operations(page); await first.promise; await refreshEvent(page); await refreshEvent(page); await page.getByRole('button', { name: 'Refresh operations', exact: true }).click();
  expect(requests).toBe(1); releaseFirst.resolve(); await second.promise;
  await expect(page.getByRole('button', { name: 'Review approval', exact: true })).toHaveCount(0); releaseSecond.resolve();
  await expect(page.locator('u2-operations')).toContainText('No action activity yet.'); expect(requests).toBe(2); expect(maxActive).toBe(1);
}));

test('closed or replaced preview ignores a late original fetch and keeps markup inert', async ({ page }) => withPage(page, async () => {
  const reached = deferred(), release = deferred(), unsafe = 'Original <img src=x onerror="window.fixtureUnsafe=true"> account';
  await page.route('**/api/actions/operations', (route) => route.fulfill({ json: { items: [...pending('fixture_a', 'Fixture A').items, ...pending('fixture_b', 'Fixture B').items], counts: { waiting_approval: 2 } } }));
  await page.route('**/api/actions/fixture_a', async (route) => { reached.resolve(); await release.promise; await route.fulfill({ json: proposal('fixture_a', 'fixture-private-late-A') }); });
  await page.route('**/api/actions/fixture_b', (route) => route.fulfill({ json: { ...proposal('fixture_b', '<script>window.fixtureUnsafe=true</script> Fixture B body'), accountBinding: { ...account, label: unsafe } } }));
  await operations(page);
  await page.locator('u2-operations').evaluate((view) => {
    const review = view._review.bind(view);
    view._review = (id) => review(id).finally(() => { if (id === 'fixture_a') window.fixtureLateReviewFinished = true; });
  });
  await page.locator('.operation-card').filter({ hasText: 'Fixture A' }).getByRole('button', { name: 'Review approval', exact: true }).click(); await reached.promise;
  await page.getByRole('button', { name: 'Close preview (does not cancel action)', exact: true }).click();
  await page.locator('.operation-card').filter({ hasText: 'Fixture B' }).getByRole('button', { name: 'Review approval', exact: true }).click();
  await expect(page.locator('.operation-review u2-approval')).toContainText('Fixture B body'); release.resolve();
  await expect.poll(() => page.evaluate(() => window.fixtureLateReviewFinished)).toBe(true);
  await expect(page.locator('.operation-review')).not.toContainText('fixture-private-late-A'); await expect(page.locator('.operation-review')).toContainText(unsafe);
  await expect(page.locator('.operation-review img, .operation-review script')).toHaveCount(0); expect(await page.evaluate(() => window.fixtureUnsafe)).toBeUndefined();
}));
