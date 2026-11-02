import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner, gotoNav } from './helpers.js';

const PASSPHRASE = 'correct horse battery staple';

// #495: the Home overview at #/home. Every endpoint it reads is stubbed with known data so each number can be asserted;
// one test runs against the real (empty) server. Approve/Reject must hit the existing approval endpoints.

const today = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const entry = (type, h, data) => ({ ts: today(h), type, eventId: `evt_${type}_${h}`, ...(data ? { data } : {}) });
const routine = (name, over = {}) => ({ path: `routines/${name}.md`, name, enabled: true, error: null, schedule: 'Every day at 09:00', skills: [], lastRun: null, ...over });

const DATA = {
  owner: { entity: { id: 'ent_owner', name: 'Christopher Robison' } },
  pending: { actions: [
    { id: 'act_one', tool: 'email.send', status: 'pending', arguments: { to: 'hidden@example.com' }, reasoning_summary: 'Follow up with the hiring manager', policy_domain: 'email', policy_rule: 'confirm' },
    { id: 'act_two', tool: 'calendar.create', status: 'pending', arguments: {}, reasoning_summary: 'Add Tuesday meeting', policy_domain: 'calendar', policy_rule: 'confirm' },
  ] },
  routines: { routines: [
    routine('Job hunter', { lastRun: { status: 'started', trigger: 'schedule', startedAt: today(8) } }),
    routine('Inbox triage', { schedule: 'When new email arrives' }),
    routine('Paused one', { enabled: false }),
    routine('Broken one', { error: 'bad yaml' }),
  ] },
  journal: { months: ['2026-11'], month: '2026-11', entries: [
    entry('agent.action.completed', 14, { tool: 'calendar.create' }), entry('agent.action.completed', 12, { tool: 'email.send' }),
    entry('routine.completed', 9, { routine: 'routines/daily-brief.md' }),
  ] },
  people: { records: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] },
  projects: { records: [{ id: 'j1', name: 'U2' }] },
  commitments: { entities: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
  vault: { vaultDir: '/v', lastIndex: { files: 12, errors: [] }, policy: { path: null, active: true, error: null }, mcp: { servers: [] } },
  model: { plannerStatus: 'configured', runtimePlannerStatus: 'configured', restartRequired: false },
  connectors: { connectors: [{ domain: 'email', active: 'gmail', connected: true }, { domain: 'calendar', active: 'google', connected: false }] },
};

/** Stub every Home endpoint. A value of `{ error: status }` makes it fail; a function is called with the route. */
async function stubHome(page, over = {}) {
  const data = { ...DATA, ...over };
  const calls = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const answer = (key) => {
      const value = data[key];
      if (value && value.error) return route.fulfill({ status: value.error, json: { error: `${key} failed` } });
      if (typeof value === 'function') return value(route);
      return route.fulfill({ json: value });
    };
    if (route.request().method() === 'GET') {
      if (p === '/api/owner/entity') return answer('owner');
      if (p === '/api/actions/pending') return answer('pending');
      if (p === '/api/routines') return answer('routines');
      if (p === '/api/vault/journal') return answer('journal');
      if (p === '/api/vault/records') return answer(url.searchParams.get('type') === 'Person' ? 'people' : 'projects');
      if (p === '/api/memory/entities') return answer('commitments');
      if (p === '/api/vault') return answer('vault');
      if (p === '/api/model') return answer('model');
      if (p === '/api/connectors') return answer('connectors');
      if (/^\/api\/actions\/[^/]+\/explain$/.test(p)) return route.fulfill({ json: { reasoningSummary: 'Because you asked.', policyDomain: 'email', policyRule: 'confirm' } });
      if (/^\/api\/actions\/[^/]+\/remember$/.test(p)) return route.fulfill({ json: { rememberable: false } });
    } else if (/^\/api\/actions\/[^/]+\/(approve|reject)$/.test(p)) {
      calls.push({ method: route.request().method(), path: p });
      return route.fulfill({ json: { status: p.endsWith('approve') ? 'executed' : 'rejected' } });
    }
    return route.fallback();
  });
  return calls;
}

// One login for the whole file (the login endpoint is rate limited); each test gets a fresh context with that session.
let storageState = null;

async function signIn(browser, baseURL, size) {
  const context = await browser.newContext({ viewport: size || { width: 1280, height: 900 }, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  return { context, page, open: async (setup) => {
    const result = setup ? await setup(page) : undefined;
    await page.goto(`${baseURL}/#/home`);
    if (await page.locator('input[name="passphrase"]').count()) {
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
    }
    await expect(page.locator('u2-home')).toBeVisible();
    if (!storageState) storageState = await context.storageState();
    return result;
  } };
}

test.describe.serial('Home overview (#495)', () => {
  let dedicated;
  test.beforeAll(async () => { dedicated = await startDedicatedServer(); await createOwner(dedicated.baseURL, PASSPHRASE); });
  test.afterAll(async () => { await stopDedicatedServer(null, dedicated); });

  test('renders every panel from the endpoints it reads', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p));
      await expect(page.locator('h1')).toHaveText(/^Good (morning|afternoon|evening), Christopher$/);
      await expect(page.locator('.home-tile__value')).toHaveText(['2', '2', '2']);
      await expect(page.locator('[data-tile="review"]')).toContainText('Need your review');
      await expect(page.locator('[data-tile="routines"]')).toContainText('Routines active');
      await expect(page.locator('[data-tile="completed"]')).toContainText('Actions completed today');

      await expect(page.locator('.home-timeline__item')).toHaveCount(3);
      await expect(page.locator('.home-timeline__time')).toHaveText(['09:00', '12:00', '14:00']);
      await expect(page.locator('.home-timeline__item').first()).toContainText('Routine completed');
      await expect(page.getByRole('link', { name: 'View journal' })).toHaveAttribute('href', '#/vault');

      const rows = page.locator('[data-panel="routines"] tbody tr');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('Job hunter');
      await expect(rows.nth(0)).toContainText('Running');
      await expect(rows.nth(1)).toContainText('When new email arrives');
      await expect(page.getByRole('link', { name: 'Manage routines' })).toHaveAttribute('href', '#/routines');

      await expect(page.locator('.home-world__count')).toHaveText(['2', '1', '3']);

      await expect(page.locator('u2-home-decision')).toHaveCount(2);
      await expect(page.locator('u2-home-decision').first()).toContainText('U2OS wants to email send');
      await expect(page.locator('u2-home-decision').first()).toContainText('Follow up with the hiring manager');
      await expect(page.locator('#workspace')).not.toContainText('hidden@example.com');

      await expect(page.locator('[data-trust="vault"]')).toContainText('12 files indexed');
      await expect(page.locator('[data-trust="policy"]')).toContainText('Your vault policy is in effect');
      await expect(page.locator('[data-trust="model"]')).toContainText('Configured');
      await expect(page.locator('[data-trust="integrations"]')).toContainText('1 of 2 connected');
      await expect(page.getByRole('link', { name: 'Open morning briefing' })).toHaveAttribute('href', '#/briefing');
    } finally { await context.close(); }
  });

  test('has landmarks, headings and no axe violations', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p));
      await expect(page.locator('u2-home-decision')).toHaveCount(2);
      await expect(page.locator('u2-home h1')).toHaveCount(1);
      await expect(page.locator('u2-home h2')).toHaveText(['Your day, handled', 'Active routines', 'Your world', 'Needs your decision', 'System trust']);
      await expect(page.getByRole('complementary', { name: 'Decisions and system status' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Active routines' })).toBeVisible();
      const axe = await new AxeBuilder({ page }).include('u2-home').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    } finally { await context.close(); }
  });

  test('empty data shows honest empty states, not invented values', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p, {
        owner: { entity: null }, pending: { actions: [] }, routines: { routines: [] }, journal: { months: [], month: null, entries: [] },
        people: { records: [] }, projects: { records: [] }, commitments: { entities: [] },
        vault: { vaultDir: '/v', lastIndex: null, policy: { active: false, error: null }, mcp: { servers: [] } },
        model: { plannerStatus: 'configuration-required', runtimePlannerStatus: 'configuration-required' }, connectors: { connectors: [] },
      }));
      await expect(page.locator('h1')).toHaveText(/^Good (morning|afternoon|evening)$/);
      await expect(page.locator('.home-tile__value')).toHaveText(['0', '0', '0']);
      await expect(page.locator('[data-panel="timeline"]')).toContainText('Nothing has been journaled today yet.');
      await expect(page.locator('[data-panel="routines"]')).toContainText('No routines yet');
      await expect(page.locator('[data-panel="decisions"]')).toContainText('Nothing needs your decision right now.');
      await expect(page.locator('.home-world__count')).toHaveText(['0', '0', '0']);
      await expect(page.locator('[data-trust="vault"]')).toContainText('Not indexed yet');
      await expect(page.locator('[data-trust="model"]')).toContainText('Not configured');
      await expect(page.locator('[data-trust="integrations"]')).toContainText('None connected');
      await expect(page.locator('u2-home-decision, tbody tr, .home-timeline__item')).toHaveCount(0);
    } finally { await context.close(); }
  });

  test('a failing source is reported on its own panel and the others still render', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p, { journal: { error: 500 }, vault: { error: 500 }, routines: { error: 503 }, people: { error: 500 } }));
      await expect(page.locator('[data-panel="timeline"] [role="alert"]')).toContainText('Your journal unavailable');
      await expect(page.locator('[data-panel="routines"] [role="alert"]')).toContainText('Routines unavailable');
      await expect(page.locator('[data-tile="completed"]')).toContainText('Unavailable');
      await expect(page.locator('[data-tile="completed"] .home-tile__value')).toHaveText('—');
      await expect(page.locator('[data-trust="vault"]')).toContainText('Unavailable');
      await expect(page.locator('[data-trust="policy"]')).toContainText('Unavailable');
      await expect(page.locator('.home-world__count')).toHaveText(['Unavailable', '1', '3']);
      // The rest is unaffected.
      await expect(page.locator('u2-home-decision')).toHaveCount(2);
      await expect(page.locator('[data-trust="model"]')).toContainText('Configured');
    } finally { await context.close(); }
  });

  test('Approve and Reject use the existing approval endpoints and announce the result', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      const calls = await open((p) => stubHome(p));
      const first = page.locator('u2-home-decision[data-action-id="act_one"]');
      await first.getByRole('button', { name: 'Approve' }).click();
      await expect(first.locator('.home-decision__status')).toHaveText('Approved and done');
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toEqual({ method: 'POST', path: '/api/actions/act_one/approve' });
      await expect(page.locator('u2-home [role="status"].sr-only')).toContainText('Approved and done');

      const second = page.locator('u2-home-decision[data-action-id="act_two"]');
      await second.getByRole('button', { name: 'Reject' }).click();
      await expect(second.locator('.home-decision__status')).toHaveText('Cancelled');
      expect(calls[1]).toEqual({ method: 'POST', path: '/api/actions/act_two/reject' });
    } finally { await context.close(); }
  });

  test('a failed approval keeps the card, re-enables its buttons and points to Operations', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open(async (p) => {
        await stubHome(p);
        await p.route('**/api/actions/act_one/approve', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
      });
      const first = page.locator('u2-home-decision[data-action-id="act_one"]');
      await first.getByRole('button', { name: 'Approve' }).click();
      await expect(first.getByRole('alert')).toContainText('check Operations');
      await expect(first.getByRole('button', { name: 'Approve' })).toBeEnabled();
    } finally { await context.close(); }
  });

  test('Why? opens the existing explanation for the action', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p));
      const first = page.locator('u2-home-decision[data-action-id="act_one"]');
      await first.getByText('Why?').click();
      await expect(first.locator('.u2-why__panel')).toContainText('Because you asked.');
    } finally { await context.close(); }
  });

  test('Ask U2 sends the text to the existing agent panel', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open((p) => stubHome(p));
      const sent = [];
      await page.route('**/api/agent/message', (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { reply: 'ok', actions: [] } }); });
      await page.locator('u2-home').getByRole('textbox', { name: 'Ask U2', exact: true }).fill('What should I focus on next?');
      await page.keyboard.press('Enter');
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0].text ?? sent[0].message).toContain('What should I focus on next?');
      await expect(page.locator('u2-home').getByRole('textbox', { name: 'Ask U2', exact: true })).toHaveValue('');
      await expect(page.locator('u2-agent')).toContainText('What should I focus on next?');
    } finally { await context.close(); }
  });

  test('is keyboard operable: decision controls are reachable by Tab and Enter approves', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      const calls = await open((p) => stubHome(p));
      await expect(page.locator('u2-home-decision')).toHaveCount(2);
      const approve = page.locator('u2-home-decision[data-action-id="act_one"] [data-action="approve"]');
      await approve.focus();
      await expect(approve).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('u2-home-decision[data-action-id="act_one"] [data-action="reject"]')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('u2-home-decision[data-action-id="act_one"] summary')).toBeFocused();
      await approve.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => calls.length).toBe(1);
    } finally { await context.close(); }
  });

  for (const [width, height] of [[375, 800], [768, 900], [1280, 900]]) {
    test(`no horizontal page scroll at ${width}px`, async ({ browser }) => {
      const { context, page, open } = await signIn(browser, dedicated.baseURL, { width, height });
      try {
        await open((p) => stubHome(p, { routines: { routines: [routine('A very long routine name that keeps going and going '.repeat(3), { schedule: 'Every weekday at 09:00 in a long timezone description' })] } }));
        await expect(page.locator('u2-home-decision')).toHaveCount(2);
        const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth, workspace: document.querySelector('#workspace').scrollWidth - document.querySelector('#workspace').clientWidth }));
        expect(overflow.doc).toBeLessThanOrEqual(0);
        expect(overflow.body).toBeLessThanOrEqual(0);
        expect(overflow.workspace).toBeLessThanOrEqual(0);
        await expect(page.locator('[data-panel="decisions"]')).toBeVisible();
        if (process.env.HOME_SHOT) await page.screenshot({ path: `${process.env.HOME_SHOT}-${width}.png` });
      } finally { await context.close(); }
    });
  }

  test('a late response after navigating away is discarded', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      let release; const gate = new Promise((resolve) => { release = resolve; });
      let reached; const arrived = new Promise((resolve) => { reached = resolve; });
      await open((p) => stubHome(p, { pending: async (route) => { reached(); await gate; await route.fulfill({ json: DATA.pending }); } }));
      await arrived;
      await gotoNav(page, '#/operations');
      await expect(page.locator('u2-operations')).toBeVisible();
      release();
      await page.waitForTimeout(300);
      await expect(page.locator('u2-home, u2-home-decision')).toHaveCount(0);
      await expect(page.locator('u2-operations')).toBeVisible();
    } finally { await context.close(); }
  });

  test('the Morning Briefing is still reachable at #/briefing', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open();
      await page.getByRole('link', { name: 'Open morning briefing' }).click();
      await expect(page).toHaveURL(/#\/briefing$/);
      await expect(page.locator('.workspace__title', { hasText: 'Morning Briefing' })).toBeVisible();
    } finally { await context.close(); }
  });

  test('against the real server with no stubs, every panel reaches a settled state', async ({ browser }) => {
    const { context, page, open } = await signIn(browser, dedicated.baseURL);
    try {
      await open();
      await expect(page.locator('.home-note', { hasText: /^Loading/ })).toHaveCount(0);
      await expect(page.locator('[data-panel]')).toHaveCount(5);
      await expect(page.locator('.home-tile__value')).not.toHaveText(['…', '…', '…']);
      for (const id of ['vault', 'policy', 'model', 'integrations']) await expect(page.locator(`[data-trust="${id}"] .home-trust__value`)).not.toHaveText('');
    } finally { await context.close(); }
  });
});
