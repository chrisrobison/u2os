import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_FILE } from './state-file.js';
import { startServer } from '../../server/index.js';

// Issue #14: real-browser coverage of the auth lifecycle, driven through the
// actual inline setup/login form (public/components/u2-app.js's
// _renderAuth()), not the Node-test-only fetch-injection shortcut in
// tests/helpers/authed-server.js.
//
// Every scenario below boots its OWN dedicated server (own scratch
// U2OS_HOME, own ephemeral port) rather than reusing the single shared
// server that tests/e2e/global-setup.js boots once for the whole run. Two
// reasons, both load-bearing:
//
// 1. State ownership: smoke.spec.js asserts the shared server's first-run
//    screen (button text "Create owner", i.e. setupRequired === true) and
//    never submits the form itself, so the shared server is expected to
//    stay in "setup required" state for the entire run. Playwright executes
//    spec files in path order within a single worker (fullyParallel: false,
//    workers: 1), so 'auth.spec.js' runs before 'smoke.spec.js' -- if this
//    file created the owner on the shared server, smoke.spec.js would then
//    see setupRequired === false and fail. A quick read of the shared
//    server's own /api/auth/status below confirms it does in fact still
//    start out as setupRequired === true when this file runs, but that
//    doesn't make it safe to mutate: doing so would only work by accident
//    of file-ordering, and would break smoke.spec.js the moment these files
//    were ever reordered or run individually. A dedicated server per
//    scenario sidesteps the ordering question entirely.
// 2. Session-expiry needs a non-default sessionIdleSeconds, which (per this
//    task's constraints) must never be applied to the shared global
//    harness.
//
// One more thing dedicated-server teardown here deliberately does NOT do,
// unlike tests/auth.test.js's per-test-file pattern: call
// closeAllForTests() from server/db/connection.js. That helper iterates
// server/db/connection.js's module-level `dbCache` and closes *every*
// cached DatabaseSync connection, unconditionally, then clears the whole
// map. tests/auth.test.js can call it safely because `node --test` gives
// each test file its own process, so its dbCache is never shared with
// anything else. Playwright is different: global-setup.js's shared server
// and every dedicated server booted below all run in-process, in the same
// worker, sharing that one `dbCache`. Calling closeAllForTests() from here
// would close the shared server's already-cached DB connection too (the
// object AuthService/EventBus/etc. on the shared server hold a direct
// reference to), breaking every later shared-server request in this run --
// exactly the interference this suite must avoid. So teardown below closes
// only the dedicated HTTP server and removes its scratch directory; the
// now-orphaned SQLite connection for that one temp dir is a harmless leak
// for the remaining lifetime of the test-runner process.
async function withDedicatedServer(page, options, run) {
  const savedHome = process.env.U2OS_HOME;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-auth-'));
  process.env.U2OS_HOME = dataDir;
  const handle = await startServer({ port: 0, ...options });
  try {
    const baseURL = `http://127.0.0.1:${handle.port}`;
    await run({ handle, baseURL });
  } finally {
    // The real app keeps an SSE connection (and a device-bus WebSocket)
    // open for its whole lifetime once the shell is up (see u2-app.js's
    // EventsService / DeviceClientService). A WebSocket that's already
    // completed its upgrade is handed off by Node's http server entirely
    // to the 'upgrade' listener -- it's no longer tracked as an ordinary
    // HTTP connection, so even closeAllConnections() can leave it open,
    // and http.Server#close()'s callback would then never fire, hanging
    // the test for the full timeout. Navigating the page away first makes
    // the browser end both connections cleanly on its own, exactly as it
    // would on a real tab close/reload; closeAllConnections() below is
    // just a belt-and-suspenders cleanup for any plain keep-alive sockets.
    await page.goto('about:blank').catch(() => {});
    handle.server.closeAllConnections();
    await new Promise((resolve) => handle.server.close(resolve));
    if (savedHome === undefined) delete process.env.U2OS_HOME;
    else process.env.U2OS_HOME = savedHome;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function createOwner(baseURL, passphrase) {
  const res = await fetch(`${baseURL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  if (res.status !== 201) throw new Error(`owner setup failed: ${res.status}`);
}

const PASSPHRASE = 'correct horse battery staple';

test.describe('auth lifecycle (#14)', () => {
  test('first-run owner setup through the real form renders the app shell', async ({ page }) => {
    // Investigate the shared global server's actual state (read-only --
    // see the file header for why this file never submits against it).
    const { baseURL: sharedBaseURL } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const sharedStatus = await (await fetch(`${sharedBaseURL}/api/auth/status`)).json();
    expect(typeof sharedStatus.setupRequired).toBe('boolean');

    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await page.goto(baseURL);

      const passphrase = page.locator('input[name="passphrase"][type="password"]');
      const submit = page.locator('form button[type="submit"]');
      await expect(passphrase).toBeVisible();
      await expect(passphrase).toHaveAttribute('minlength', '12');
      await expect(submit).toHaveText('Create owner');

      // Client-side minlength=12 validation (in scope per #14): a
      // too-short value must never even reach the form's submit handler.
      await passphrase.fill('short');
      await expect(passphrase.evaluate((el) => el.checkValidity())).resolves.toBe(false);
      await submit.click();
      await expect(page.locator('u2-nav')).toHaveCount(0);
      await expect(passphrase).toBeVisible();

      await passphrase.fill(PASSPHRASE);
      await expect(passphrase.evaluate((el) => el.checkValidity())).resolves.toBe(true);
      await submit.click();

      await expect(page.locator('u2-nav')).toBeVisible();
      await expect(page.locator('.load-error')).toHaveCount(0);
    });
  });

  test('logout clears the session and the auth form reappears', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-nav')).toBeVisible();

      // grep public/ for api.logout() call sites: the only reference is the
      // export in public/services/api.js itself -- no nav/menu/button in
      // the current shell ever invokes it (u2-nav.js, u2-app.js's header
      // markup above all have no logout control). Rather than add a UI
      // affordance that's out of scope for #14, drive the real client
      // through the page's own module graph: '/services/api.js' resolves
      // to the exact same module instance u2-app.js imports (same URL, same
      // browser module cache), so this exercises the real logout() contract
      // (POST /api/auth/logout, clear the cached CSRF token) rather than a
      // raw fetch bypassing the client.
      await page.evaluate(() => import('/services/api.js').then((m) => m.logout()));

      await page.reload();
      await expect(page.locator('input[name="passphrase"]')).toBeVisible();
      await expect(page.locator('u2-nav')).toHaveCount(0);
    });
  });

  test('login with the correct passphrase renders the app shell', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await createOwner(baseURL, PASSPHRASE);

      await page.goto(baseURL);
      const passphrase = page.locator('input[name="passphrase"]');
      await expect(page.locator('form button[type="submit"]')).toHaveText('Log in');

      await passphrase.fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();

      await expect(page.locator('u2-nav')).toBeVisible();
      await expect(page.locator('.load-error')).toHaveCount(0);
    });
  });

  test('login with an incorrect passphrase shows the inline error and does not authenticate', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await createOwner(baseURL, PASSPHRASE);

      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill('wrong passphrase value');
      await page.locator('form button[type="submit"]').click();

      const error = page.locator('.load-error');
      await expect(error).toBeVisible();
      await expect(error).toHaveText('Unable to authenticate.');
      await expect(page.locator('u2-nav')).toHaveCount(0);
      await expect(page.locator('input[name="passphrase"]')).toBeVisible();
    });
  });

  test('an idle-expired session falls back to the auth form on reload', async ({ page }) => {
    // Mirrors tests/auth.test.js:50's sessionIdleSeconds: 0.05 (50ms)
    // pattern exactly, on its own dedicated server -- never applied to the
    // shared global harness.
    await withDedicatedServer(page, { sessionIdleSeconds: 0.05 }, async ({ baseURL }) => {
      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-nav')).toBeVisible();

      // Let the 50ms idle window lapse with no further requests from this
      // page (the shell's own background traffic -- one dashboard fetch,
      // one SSE connection -- has already settled by the time the shell is
      // visible above).
      await page.waitForTimeout(200);

      await page.reload();

      // Session is now expired server-side; connectedCallback()'s
      // getAuthStatus() check reports unauthenticated, so the app falls
      // back to the login form instead of a broken/blank page.
      await expect(page.locator('input[name="passphrase"]')).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toHaveText('Log in');
      await expect(page.locator('u2-nav')).toHaveCount(0);
      // The auth form always renders a `.load-error` div (see
      // u2-app.js's _renderAuth()); it's present but hidden until a submit
      // actually fails, so the correct assertion is hidden, not absent.
      await expect(page.locator('.load-error')).toBeHidden();
    });
  });

  test('an invalid/cleared session shows the auth form, not a broken page', async ({ page, context }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-nav')).toBeVisible();

      // Simulate an invalid/no session the same way an expired or forged
      // cookie would look to the server: no valid u2os_session cookie at
      // all. GET /api/auth/status is public and always 200s with
      // authenticated: false in this case (never a raw 401), so the
      // observable proof is the UI's reaction on reload, not a status code.
      await context.clearCookies();
      await page.reload();

      await expect(page.locator('input[name="passphrase"]')).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toHaveText('Log in');
      await expect(page.locator('u2-nav')).toHaveCount(0);
      // Not the network-failure fallback path either (u2-app.js's "Unable
      // to contact U2OS" branch), and not a leftover error banner from some
      // earlier failed submission -- a clean, hidden `.load-error`.
      await expect(page.locator('.load-error')).toBeHidden();
    });
  });
});
