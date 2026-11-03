import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startSeededServer, signInState, openPage, ready, noPageScroll, viewHash } from './job-hunt-e2e-helpers.js';

// #653: responsive layout and accessibility of every Job Hunt view against the REAL server (seeded through the hunt
// store, no stubbed endpoints): the Overview, the Opportunities table, the table with the detail panel open (a drawer
// on narrow screens), Agent Operations and the full job page, at 360, 768, 1024 and 1440 px, light and dark.

const WIDTHS = [360, 768, 1024, 1440];
const KINDS = ['overview', 'opportunities', 'panel', 'operations', 'page'];
const AXE_KINDS = [...KINDS, 'readyPage', 'readyPanel'];

test.describe('job hunt polish: responsive and accessible (#653)', () => {
  let server;
  let state;
  test.beforeAll(async ({ browser }) => {
    server = await startSeededServer();
    state = await signInState(browser, server.baseURL);
  });
  test.afterAll(async () => { await server?.stop(); });

  for (const width of WIDTHS) {
    test(`no view scrolls the page sideways at ${width}px, and every control is a comfortable touch target when narrow`, async ({ browser }) => {
      const touch = width <= 768;
      const hashes = viewHash(server.ids);
      for (const kind of KINDS) {
        const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes[kind], width, touch });
        try {
          await ready(page, kind);
          expect(await noPageScroll(page), `${kind} at ${width}px scrolls sideways`).toBe(true);
          if (!touch) continue;
          const small = await page.evaluate(() => {
            const out = [];
            const de = document.documentElement;
            const controls = document.querySelectorAll('#workspace a[href], #workspace button, #workspace input:not([type="hidden"]), #workspace select, #workspace textarea, #workspace summary, #workspace [role="tab"]');
            for (const node of controls) {
              const box = node.getBoundingClientRect();
              if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden' || box.right < 0 || box.left > de.clientWidth) continue;
              if (node.closest('[inert]')) continue; // the page behind an open drawer is out of reach
              const check = node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio');
              const min = check ? 24 : 44;
              if (box.height < min - 0.5 || (node.matches('button, summary, [role="tab"], input, select') && box.width < min - 0.5)) {
                out.push(`${node.tagName.toLowerCase()} "${(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
              }
            }
            return [...new Set(out)];
          });
          expect(small, `${kind} at ${width}px has small targets`).toEqual([]);
        } finally { await context.close(); }
      }
    });
  }

  test('the detail panel is a drawer on narrow screens (page behind it inert, Escape and a tap close it) and sits beside the table on wide ones', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    for (const width of [360, 768]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.opportunities, width, touch: true });
      try {
        await ready(page, 'opportunities');
        const row = page.locator('tr[data-job]').nth(1);
        await row.locator('[data-col="role"] a').scrollIntoViewIfNeeded();
        await row.focus();
        await page.keyboard.press('Enter');
        const drawer = page.locator('[data-region="detail"]');
        await expect(page.locator('u2-job-detail-panel [data-part="heading"]')).toBeFocused();
        await expect.poll(async () => { const box = await drawer.boundingBox(); return box.x + box.width; }, { message: 'the drawer slides in flush with the right edge' }).toBeCloseTo(width, 0);
        expect((await drawer.boundingBox()).width).toBeLessThanOrEqual(width);
        await expect(page.locator('[data-region="main"]')).toHaveJSProperty('inert', true);
        // Escape closes it, focus returns to the row, and the page is live again.
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
        await expect(page.locator('[data-region="main"]')).toHaveJSProperty('inert', false);
        await expect(page.locator('tr[data-job]').nth(1)).toBeFocused();
        // A tap on the dimmed page closes it too.
        await page.locator('tr[data-job]').nth(1).locator('[data-col="company"]').click();
        await expect(drawer).toBeVisible();
        await page.mouse.click(4, Math.min(500, 400));
        await expect(drawer).toBeHidden();
        expect(await noPageScroll(page)).toBe(true);
      } finally { await context.close(); }
    }
    for (const width of [1024, 1440]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.panel, width });
      try {
        await ready(page, 'panel');
        const main = await page.locator('[data-region="main"]').boundingBox();
        const detail = await page.locator('[data-region="detail"]').boundingBox();
        expect(detail.x, `at ${width}px the panel sits beside the table`).toBeGreaterThanOrEqual(main.x + main.width - 1);
        await expect(page.locator('[data-region="main"]')).toHaveJSProperty('inert', false);
        expect(await noPageScroll(page)).toBe(true);
      } finally { await context.close(); }
    }
  });

  test('the drawer slides only when the owner has not asked for reduced motion', async ({ browser }) => {
    for (const [reducedMotion, expected] of [['no-preference', '0.2s'], ['reduce', '0s']]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: viewHash(server.ids).opportunities, width: 360, touch: true, reducedMotion });
      try {
        await ready(page, 'opportunities');
        const duration = await page.locator('[data-region="detail"]').evaluate((node) => getComputedStyle(node).transitionDuration);
        expect(duration, `prefers-reduced-motion: ${reducedMotion}`).toBe(expected);
      } finally { await context.close(); }
    }
  });

  test('the Opportunities table keeps the columns that identify a job on a phone and all of them on a desktop', async ({ browser }) => {
    const hashes = viewHash(server.ids);
    for (const [width, columns] of [[360, ['company', 'role', 'fit', 'status']], [1440, ['company', 'role', 'location', 'comp', 'fit', 'status', 'posted']]]) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes.opportunities, width });
      try {
        await ready(page, 'opportunities');
        const visible = await page.locator('thead th[data-col]').evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).display !== 'none').map((node) => node.getAttribute('data-col')));
        expect(visible).toEqual(columns);
      } finally { await context.close(); }
    }
  });

  for (const theme of ['light', 'dark']) {
    test(`axe finds no violations on any job-hunt view in the ${theme} theme (wide and phone)`, async ({ browser }) => {
      const hashes = viewHash(server.ids);
      for (const width of [1280, 360]) {
        for (const kind of AXE_KINDS) {
          const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: hashes[kind], width, theme, touch: width < 500 });
          try {
            await ready(page, kind);
            const result = await new AxeBuilder({ page }).include('#workspace').analyze();
            const found = result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
            expect(found, `${kind} ${theme} ${width}px`).toEqual([]);
          } finally { await context.close(); }
        }
      }
    });
  }
  test('company monogram initials keep 4.5:1 against their chip for every hue in both themes', async ({ browser }) => {
    for (const theme of ['light', 'dark']) {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: viewHash(server.ids).opportunities, width: 1280, theme });
      try {
        await ready(page, 'opportunities');
        const worst = await page.evaluate(() => {
          const parse = (css) => {
            const nums = css.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
            const [r, g, b] = css.startsWith('color(') ? nums.slice(0, 3).map((n) => n * 255) : nums.slice(0, 3);
            return [r, g, b];
          };
          const lum = ([r, g, b]) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const host = document.querySelector('u2-job-opportunities');
          let worstRatio = Infinity; let worstHue = null;
          for (let hue = 0; hue < 360; hue += 6) {
            const node = document.createElement('span');
            node.className = 'jh-mono jh-mono--md';
            node.textContent = 'AB';
            node.style.setProperty('--jh-hue', String(hue));
            host.append(node);
            const cs = getComputedStyle(node);
            const [a, b] = [lum(parse(cs.color)), lum(parse(cs.backgroundColor))];
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < worstRatio) { worstRatio = ratio; worstHue = hue; }
            node.remove();
          }
          return { worstRatio, worstHue };
        });
        expect(worst.worstRatio, `${theme}: worst hue ${worst.worstHue}`).toBeGreaterThanOrEqual(4.5);
      } finally { await context.close(); }
    }
  });

  for (const theme of ['light', 'dark']) {
    test(`axe finds no violations on any panel tab of a job that is ready to submit (${theme})`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: viewHash(server.ids).readyPanel, width: 1280, theme });
      try {
        await ready(page, 'readyPanel');
        const panel = page.locator('u2-job-detail-panel');
        for (const tab of ['Overview', 'Match Analysis', 'Application', 'Company', 'Notes']) {
          await panel.getByRole('tab', { name: tab }).click();
          await expect(panel.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
          if (tab === 'Application') await expect(panel.locator('[data-submit-box]')).toBeVisible();
          if (tab === 'Notes') await expect(panel.locator('u2-job-notes textarea')).toBeVisible();
          const result = await new AxeBuilder({ page }).include('u2-job-detail-panel').analyze();
          expect(result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), `${tab} tab, ${theme}`).toEqual([]);
        }
      } finally { await context.close(); }
    });

    test(`axe finds no violations on Agent Operations with approvals, a running action, failures and history (${theme})`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { baseURL: server.baseURL, state, hash: viewHash(server.ids).opportunities, width: 1280, theme });
      try {
        const ago = (ms) => new Date(Date.now() - ms).toISOString();
        const job = server.ids['needs-1'];
        const row = (over) => ({ tool: 'jobs.send_application', label: 'Send application email', requestedBy: 'job-autopilot', jobId: job, company: 'Northern Lights', role: 'Staff Engineer', ...over });
        await page.route('**/api/job-hunt/operations', (route) => route.fulfill({ json: {
          generatedAt: new Date().toISOString(),
          autopilot: { mode: 'live', execution: 'degraded', detail: 'score: model unreachable', lastRunAt: ago(120_000), cycleRunning: false, lastCycle: { startedAt: ago(300_000), finishedAt: ago(120_000), mode: 'live', actions: 3, needsYou: 1, errors: 1 }, settingsChangedAt: ago(86_400_000) },
          running: { count: 1, items: [row({ id: 'act_r', status: 'executing', since: ago(60_000), attempts: 2 })] },
          awaitingApproval: { count: 2, items: [row({ id: 'act_a', status: 'pending', since: ago(3_600_000) }), row({ id: 'act_b', status: 'pending', since: ago(7_200_000), jobId: null, company: null, role: null })] },
          recent: [row({ id: 'act_c', status: 'executed', at: ago(900_000) }), row({ id: 'act_d', status: 'rejected', at: ago(1_800_000) })],
          failures: [{ source: 'action', label: 'Submit application', jobId: job, company: 'Northern Lights', role: 'Staff Engineer', status: 'failed', message: 'The form showed an error', at: ago(600_000) }],
          lastActivity: { autopilotCycleAt: ago(120_000), lastActionAt: ago(900_000), lastFailureAt: ago(600_000) },
        } }));
        await page.goto(`${server.baseURL}/${viewHash(server.ids).operations}`);
        await expect(page.locator('[data-part="approval-count"]')).toHaveText('2');
        await expect(page.locator('[data-part="message"]')).toContainText('The form showed an error');
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const result = await new AxeBuilder({ page }).include('#workspace').analyze();
        expect(result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
        expect(await noPageScroll(page)).toBe(true);
      } finally { await context.close(); }
    });
  }
});
