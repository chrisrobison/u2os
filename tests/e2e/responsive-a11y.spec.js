import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { proposeMemoryCandidate } from '../../server/memory/candidate-store.js';

// Issue #19 (last child of Milestone 3, #12): baseline responsive layout +
// accessibility coverage for the shell. One dedicated server + one shared,
// logged-in page across this whole file, same reasoning as
// navigation.spec.js (#15): everything here is read-mostly against the
// shell/seeded data, driven through real viewport/media-emulation state
// rather than needing per-scenario isolation. `beforeEach` below resets
// viewport size, reduced-motion emulation, hash, theme, and drawer state
// before every test so tests don't leak state into each other despite
// sharing one page.
//
// ---- Scoping decisions, made up front from reading the real CSS/markup
// (see PROMPT context for the exact line numbers/rules cited below) ----
//
// * Dialogs: `grep -rn '<dialog\|role="dialog"' public/components/` turns
//   up nothing. Approval cards (<u2-approval>, public/components/u2-approval.js)
//   render inline in the dashboard/agent transcript, not as a native
//   <dialog> or an ARIA `role="dialog"` modal, so there is no real
//   focus-trap behavior to test. The "dialog behavior" test below is a
//   trip-wire assertion (no dialog/role=dialog anywhere at runtime) rather
//   than fabricated focus-trap coverage for a modal that doesn't exist.
// * Reduced motion: base.css defines exactly one global rule for this
//   (`@media (prefers-reduced-motion: reduce) { *, *::before, *::after {
//   animation-duration: 0.001ms !important; transition-duration: 0.001ms
//   !important; } }`, line ~23) plus one concrete transitioning element
//   that's actually reachable without contrivance: `.shell__nav`'s
//   `transition: transform 220ms ease` under the `max-width: 900px` drawer
//   breakpoint. (`.u2-timeline__item.is-new`'s slide-in animation only
//   applies via `_render(highlightFirst = true)` on a live SSE push --
//   public/components/u2-timeline.js -- never on a plain page load, so it's
//   not a practical target here; the drawer transition covers the same
//   global rule just as concretely.)
// * Contrast: axe-core (`@axe-core/playwright`, added as a devDependency
//   for this issue -- two packages, axe-core + its Playwright wrapper, in
//   line with this repo's few-dependencies posture) runs as one input, but
//   per issue #19's explicit requirement it is NOT the sole check and NOT
//   a blocking gate (see also the issue's non-goal: "no comprehensive WCAG
//   audit tooling integration as a blocking CI gate") -- its
//   color-contrast findings are attached to the test report for a human to
//   read, not asserted to be empty. The actual asserted contrast baseline
//   is a manual spot-check computed from real getComputedStyle() values
//   (WCAG relative-luminance formula, not a hardcoded ratio) against
//   themes.css's --text-primary/--bg-page pair in both the light and dark
//   `data-theme` variants.

const PASSPHRASE = 'correct horse battery staple';

function relLuminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(rgbA, rgbB) {
  const lA = relLuminance(rgbA);
  const lB = relLuminance(rgbB);
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(cssColor) {
  const nums = cssColor.match(/[\d.]+/g).map(Number);
  return [nums[0], nums[1], nums[2]];
}

test.describe.serial('responsive layout & accessibility baseline (#19)', () => {
  let dedicated;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);

    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  test.beforeEach(async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${dedicated.baseURL}/#/home`);
    await expect(page.locator('.workspace__title')).toBeVisible();
    // Force a known, deterministic starting theme + closed-drawer state --
    // this is the same document across the whole file (hash-only
    // navigations don't reload it), so a prior test's mutations would
    // otherwise leak forward.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      const app = document.querySelector('u2-app');
      if (app) { app.dataset.navOpen = 'false'; app.dataset.agentOpen = 'false'; }
    });
  });

  // ---------------------------------------------------------------------
  // 1. Viewport sweep: desktop / tablet / phone.
  // ---------------------------------------------------------------------

  test('desktop viewport (1280x800): nav and agent render inline (not as drawers)', async () => {
    // Drawer toggles are unconditionally rendered in the header markup
    // (u2-app.js). Naively reading base.css in isolation suggests they're
    // hidden outside the `max-width: 900px` breakpoint
    // (`.shell__drawer-toggle { display: none; }`), but verifying via
    // real getComputedStyle() shows otherwise: the buttons also carry
    // `.icon-btn`, whose `display: inline-flex` has equal (single-class)
    // specificity and appears LATER in base.css's cascade order, so it
    // wins the tie -- the toggle buttons are actually visible at every
    // viewport width, not just <=900px. The breakpoint's own
    // `display: inline-flex` override for `.shell__drawer-toggle` is
    // therefore redundant (restates a value already in effect). What
    // actually makes the desktop shell non-drawer-mode is that
    // `.shell__nav`/`.shell__agent`'s `position: fixed` + `transform`
    // rules only exist inside that same `max-width: 900px` query --
    // outside it, nav/agent stay in the normal 3-column grid regardless of
    // the toggle buttons' visibility or the `data-nav-open`/
    // `data-agent-open` attributes.
    await expect(page.locator('[data-toggle="nav"]')).toHaveCount(1);
    await expect(page.locator('[data-toggle="nav"]')).toBeVisible();
    await expect(page.locator('[data-toggle="agent"]')).toBeVisible();

    await expect(page.locator('.shell__nav')).toBeVisible();
    await expect(page.locator('.shell__agent')).toBeVisible();
    await expect(page.locator('u2-nav a[data-route="#/mail"]')).toBeVisible();
    await expect(page.locator('.agent-panel__input')).toBeVisible();

    // Not positioned as an off-canvas drawer at this width: normal grid
    // flow (left column), not a translated fixed overlay.
    const navBox = await page.locator('.shell__nav').boundingBox();
    expect(navBox.x).toBeGreaterThanOrEqual(0);
    expect(navBox.x).toBeLessThan(50);

    await expect(page.locator('.shell__scrim')).toHaveCSS('display', 'none');
  });

  test('tablet viewport (820x1180): drawer mode active, nav/agent start off-canvas', async () => {
    // Avoid sampling the 220ms desktop-to-drawer transition immediately
    // after the viewport crosses the responsive breakpoint.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`${dedicated.baseURL}/#/home`);

    await expect(page.locator('[data-toggle="nav"]')).toBeVisible();
    await expect(page.locator('[data-toggle="agent"]')).toBeVisible();

    const navBox = await page.locator('.shell__nav').boundingBox();
    expect(navBox.x).toBeLessThan(0); // translateX(-100%): off-canvas left

    const agentBox = await page.locator('.shell__agent').boundingBox();
    expect(agentBox.x).toBeGreaterThanOrEqual(820 - 1); // translateX(100%): off-canvas right

    await expect(page.locator('.shell__scrim')).toHaveCSS('display', 'none');

    // Core content is still reachable (main pane isn't hidden, just full-width).
    await expect(page.locator('.workspace__title', { hasText: 'Morning Briefing' })).toBeVisible();
  });

  test('phone viewport (390x844): nav/agent drawers open via their toggle buttons and close via the scrim', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Reduced motion so `.shell__nav`/`.shell__agent`'s 220ms transform
    // transition collapses to ~0 -- boundingBox() reads below are then the
    // settled end-state rather than a mid-transition snapshot.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${dedicated.baseURL}/#/home`);

    const app = page.locator('u2-app');
    const nav = page.locator('.shell__nav');
    const agent = page.locator('.shell__agent');
    const scrim = page.locator('.shell__scrim');

    await expect.poll(async () => (await nav.boundingBox()).x).toBeLessThan(0);
    await expect(scrim).toHaveCSS('display', 'none');

    // Open nav via its real toggle button.
    await page.locator('[data-toggle="nav"]').click();
    await expect(app).toHaveAttribute('data-nav-open', 'true');
    await expect(scrim).toHaveCSS('display', 'block');
    await expect.poll(async () => Math.abs((await nav.boundingBox()).x)).toBeLessThan(5);

    // Click the scrim at a point not covered by the (now on-screen, ~220px
    // wide) nav panel to close it -- the scrim's own click handler calls
    // u2-app.js's _closeDrawers().
    await scrim.click({ position: { x: 350, y: 200 } });
    await expect(app).toHaveAttribute('data-nav-open', 'false');
    await expect(scrim).toHaveCSS('display', 'none');
    await expect.poll(async () => (await nav.boundingBox()).x).toBeLessThan(0);

    // Agent drawer toggles independently of nav.
    await page.locator('[data-toggle="agent"]').click();
    await expect(app).toHaveAttribute('data-agent-open', 'true');
    await expect(app).toHaveAttribute('data-nav-open', 'false');
    await expect.poll(async () => (await agent.boundingBox()).x).toBeLessThan(390 - 5);

    // The scrim closes BOTH drawers at once (real _closeDrawers()
    // behavior), even though only the agent drawer is currently open.
    await scrim.click({ position: { x: 20, y: 200 } });
    await expect(app).toHaveAttribute('data-agent-open', 'false');
    await expect(app).toHaveAttribute('data-nav-open', 'false');
    await expect(scrim).toHaveCSS('display', 'none');
  });

  // ---------------------------------------------------------------------
  // 2 & 3. Keyboard navigation + visible focus states.
  // ---------------------------------------------------------------------

  async function activeElementInfo() {
    return page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName,
        id: el.id || undefined,
        dataRoute: el.dataset ? el.dataset.route : undefined,
        className: typeof el.className === 'string' ? el.className : '',
      };
    });
  }

  test('keyboard: Tab reaches a real nav link and the chat composer textarea', async ({ browserName }) => {
    let foundLink = null;
    let foundComposer = false;
    // macOS WebKit follows Safari's system keyboard-access convention:
    // Option+Tab includes links, while plain Tab visits form controls.
    const tabKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    for (let i = 0; i < 60 && (!foundLink || !foundComposer); i++) {
      await page.keyboard.press(tabKey);
      const info = await activeElementInfo();
      if (!info) continue;
      if (!foundLink && info.tag === 'A' && info.dataRoute) foundLink = info;
      if (info.tag === 'TEXTAREA' && info.className.includes('agent-panel__input')) foundComposer = true;
    }
    expect(foundLink?.dataRoute).toMatch(/^#\//);
    expect(foundComposer).toBe(true);
  });

  test('keyboard: Enter activates a keyboard-focused nav link', async () => {
    const mailLink = page.locator('u2-nav a[data-route="#/mail"]');
    await mailLink.focus();
    expect((await activeElementInfo())?.dataRoute).toBe('#/mail');

    // Real <a href="#/mail">, so Enter (not Space -- browsers only fire a
    // click from Space on buttons/inputs, not plain links) triggers native
    // anchor activation.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/mail$/);
    await expect(page.locator('.workspace__title', { hasText: 'Mail' })).toBeVisible();
    expect((await activeElementInfo())?.id).toBe('workspace');
  });

  test('keyboard: skip link is first and moves focus directly to the workspace', async () => {
    const skip = page.locator('.skip-link');
    await expect(page.locator('.shell > :first-child')).toHaveClass(/skip-link/);
    await skip.focus();
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#workspace')).toBeFocused();
  });

  test('keyboard: Space activates a keyboard-focused button (theme toggle)', async () => {
    const themeBtn = page.locator('[data-toggle="theme"]');
    await themeBtn.focus();
    expect(await themeBtn.evaluate((el) => document.activeElement === el)).toBe(true);

    const before = await themeBtn.textContent();
    await page.keyboard.press('Space');
    await expect.poll(() => themeBtn.textContent()).not.toBe(before);
  });

  test('focus-visible: keyboard focus applies a real outline; unfocused elements have none', async ({ browserName }) => {
    const homeLink = page.locator('u2-nav a[data-route="#/home"]');
    const before = await homeLink.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(before).toBe('none');

    let landed = false;
    const tabKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    for (let i = 0; i < 20 && !landed; i++) {
      await page.keyboard.press(tabKey);
      landed = await homeLink.evaluate((el) => document.activeElement === el);
    }
    expect(landed).toBe(true);

    const focused = await homeLink.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    });
    // base.css: `:focus-visible { outline: 2px solid var(--focus-ring);
    // outline-offset: 2px; }`.
    expect(focused.style).toBe('solid');
    expect(focused.width).toBe('2px');
  });

  // ---------------------------------------------------------------------
  // 4. Semantic labels (auth form + memory-candidate form).
  // ---------------------------------------------------------------------

  test('auth form: passphrase input resolves via its <label> (real, accessible-name association)', async ({ browser }) => {
    // The shared `page` is already logged in, so check this against a
    // fresh, cookie-less context against the same server (still shows the
    // real _renderAuth() markup -- "Unlock U2OS" since an owner already
    // exists -- same nested-label structure as the "Create owner" variant).
    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      await freshPage.goto(dedicated.baseURL);
      await expect(freshPage.getByLabel('Passphrase')).toHaveAttribute('name', 'passphrase');
      await expect(freshPage.getByLabel('Passphrase')).toHaveAttribute('type', 'password');
    } finally {
      await freshContext.close();
    }
  });

  test('memory-candidate form: "Attach to" and "Fact key" inputs resolve via their <label>s', async () => {
    const content = 'Enjoys hiking on weekends';
    proposeMemoryCandidate({ content, confidence: 'medium', proposedBy: 'owner' });

    await page.goto(`${dedicated.baseURL}/#/memory`);
    const card = page.locator('.dashboard-card', { hasText: content });
    await expect(card).toBeVisible();

    await expect(card.getByLabel('Attach to')).toHaveAttribute('name', 'entityId');
    await expect(card.getByLabel('Fact key')).toHaveAttribute('name', 'key');

    // Clean up so this candidate doesn't linger for later tests/state.
    await card.locator('[data-reject]').click();
    await expect(page.locator('.dashboard-card', { hasText: content })).toHaveCount(0);
  });

  // ---------------------------------------------------------------------
  // 5. Dialog/action-prompt behavior.
  // ---------------------------------------------------------------------

  test('no native <dialog>/role="dialog" modal exists anywhere in the shell (documented finding, not fabricated coverage)', async () => {
    // grep -rn '<dialog\|role="dialog"' public/components/ -> no matches.
    // Approval cards (<u2-approval>) render inline in the dashboard/agent
    // transcript, not as a modal, so there's no real focus-trap to assert.
    // This is a trip-wire: if a genuine modal dialog is ever introduced,
    // this assertion should fail and prompt real focus-trap coverage to be
    // added here instead of silently going stale.
    await page.goto(`${dedicated.baseURL}/#/home`);
    const dialogCount = await page.locator('dialog, [role="dialog"]').count();
    expect(dialogCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 6. Contrast: axe-core as one input (not the sole check) + a manual,
  // computed spot-check as the actually-asserted baseline.
  // ---------------------------------------------------------------------

  test('axe-core scan of the dashboard (informational cross-check, not a blocking gate)', async () => {
    await page.goto(`${dedicated.baseURL}/#/home`);
    await expect(page.locator('.workspace__title')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(Array.isArray(results.violations)).toBe(true);

    const contrastViolations = results.violations.filter((v) => v.id === 'color-contrast');
    // Attached for a human to read rather than asserted empty: per issue
    // #19's non-goal ("no comprehensive WCAG audit tooling integration as a
    // blocking CI gate"), a real pre-existing gap here (see the manual
    // spot-check test below for the asserted baseline; --text-tertiary on
    // --bg-page is ~3.36:1 in light mode by hand-computed WCAG luminance
    // math against themes.css, below the 4.5:1 AA threshold for the normal
    // -sized text it's used on, e.g. the nav footer / timestamps) should
    // surface here for follow-up rather than fail this suite.
    await test.info().attach('axe-color-contrast-violations.json', {
      body: JSON.stringify(contrastViolations, null, 2),
      contentType: 'application/json',
    });
  });

  test('manual contrast spot-check: workspace title text vs. page background clears AA in both themes', async () => {
    await page.goto(`${dedicated.baseURL}/#/home`);
    await expect(page.locator('.workspace__title')).toBeVisible();

    const ratios = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const [fg, bg] = await Promise.all([
        page.locator('.workspace__title').evaluate((el) => getComputedStyle(el).color),
        page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      ]);
      ratios[theme] = contrastRatio(parseRgb(fg), parseRgb(bg));
    }

    // Hand-computed against themes.css's real values (light:
    // --text-primary #171B1E on --bg-page #EEF1F2 ~= 15.3:1; dark:
    // --text-primary #E7ECEF on --bg-page #0D1116 ~= 15.9:1) -- both
    // comfortably clear the 4.5:1 WCAG AA threshold for normal text. This
    // is the asserted contrast baseline for this issue; axe above is the
    // supplementary automated input.
    expect(ratios.light).toBeGreaterThanOrEqual(4.5);
    expect(ratios.dark).toBeGreaterThanOrEqual(4.5);
  });

  // ---------------------------------------------------------------------
  // 7. prefers-reduced-motion.
  // ---------------------------------------------------------------------

  test('prefers-reduced-motion collapses the drawer transition to ~0', async () => {
    // .shell__nav's `transition: transform 220ms ease` only applies under
    // the `max-width: 900px` drawer breakpoint (base.css).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${dedicated.baseURL}/#/home`);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normalDuration = await page.locator('.shell__nav').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(normalDuration).toBe('0.22s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedDuration = await page.locator('.shell__nav').evaluate((el) => getComputedStyle(el).transitionDuration);
    // base.css's global override: `transition-duration: 0.001ms !important`
    // under `@media (prefers-reduced-motion: reduce)`.
    expect(parseFloat(reducedDuration)).toBeLessThan(0.001);
  });
});
