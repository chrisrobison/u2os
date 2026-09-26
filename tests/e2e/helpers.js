// Shared helpers for e2e specs that need a dedicated, isolated, authenticated
// server -- extracted from auth.spec.js (issue #14) during issue #15 so
// navigation.spec.js doesn't duplicate it, and so future specs (#16-#19) that
// need the same pattern have one place to import it from.
//
// Every scenario that uses this boots its OWN dedicated server (own scratch
// U2OS_HOME, own ephemeral port) rather than reusing the single shared server
// that tests/e2e/global-setup.js boots once for the whole run. Two reasons,
// both load-bearing:
//
// 1. State ownership: smoke.spec.js asserts the shared server's first-run
//    screen (button text "Create owner", i.e. setupRequired === true) and
//    never submits the form itself, so the shared server is expected to stay
//    in "setup required" state for the entire run. Playwright executes spec
//    files in path order within a single worker (fullyParallel: false,
//    workers: 1); a dedicated server per scenario sidesteps the file-ordering
//    question entirely rather than relying on it.
// 2. Some scenarios (e.g. auth.spec.js's session-expiry test) need a
//    non-default server option (like a short sessionIdleSeconds), which must
//    never be applied to the shared global harness.
//
// One more thing teardown here deliberately does NOT do, unlike
// tests/auth.test.js's per-test-file pattern: call closeAllForTests() from
// server/db/connection.js. That helper iterates server/db/connection.js's
// module-level `dbCache` and closes *every* cached DatabaseSync connection,
// unconditionally, then clears the whole map. tests/auth.test.js can call it
// safely because `node --test` gives each test file its own process, so its
// dbCache is never shared with anything else. Playwright is different:
// global-setup.js's shared server and every dedicated server booted below all
// run in-process, in the same worker, sharing that one `dbCache`. Calling
// closeAllForTests() from here would close the shared server's already-cached
// DB connection too (the object AuthService/EventBus/etc. on the shared
// server hold a direct reference to), breaking every later shared-server
// request in this run -- exactly the interference this suite must avoid. So
// teardown below closes only the dedicated HTTP server and removes its
// scratch directory; the now-orphaned SQLite connection for that one temp dir
// is a harmless leak for the remaining lifetime of the test-runner process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';

/**
 * Boots a dedicated server against a fresh scratch U2OS_HOME. Returns a
 * handle for use with `stopDedicatedServer` (or pass both to
 * `withDedicatedServer` for the common single-test case).
 */
export async function startDedicatedServer(options = {}) {
  const savedHome = process.env.U2OS_HOME;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-e2e-'));
  process.env.U2OS_HOME = dataDir;
  const handle = await startServer({ port: 0, mode: 'demo', ...options });
  const baseURL = `http://127.0.0.1:${handle.port}`;
  return { handle, baseURL, _savedHome: savedHome, _dataDir: dataDir };
}

/**
 * Tears down a server started with `startDedicatedServer`. Takes a `page`
 * (or `null` if no page was ever opened against this server) so it can
 * navigate away first: the real app keeps an SSE connection (and a
 * device-bus WebSocket) open for its whole lifetime once the shell is up
 * (see u2-app.js's EventsService / DeviceClientService). A WebSocket that's
 * already completed its upgrade is handed off by Node's http server entirely
 * to the 'upgrade' listener -- it's no longer tracked as an ordinary HTTP
 * connection, so even closeAllConnections() can leave it open, and
 * http.Server#close()'s callback would then never fire, hanging the test for
 * the full timeout. Navigating the page away first makes the browser end
 * both connections cleanly on its own, exactly as it would on a real tab
 * close/reload; closeAllConnections() below is just a belt-and-suspenders
 * cleanup for any plain keep-alive sockets.
 */
export async function stopDedicatedServer(page, dedicated) {
  const { handle, _savedHome, _dataDir } = dedicated;
  if (page) await page.goto('about:blank').catch(() => {});
  handle.server.closeAllConnections();
  await new Promise((resolve) => handle.server.close(resolve));
  await handle.closed;
  if (_savedHome === undefined) delete process.env.U2OS_HOME;
  else process.env.U2OS_HOME = _savedHome;
  fs.rmSync(_dataDir, { recursive: true, force: true });
}

/** Single-test convenience wrapper around start/stopDedicatedServer. */
export async function withDedicatedServer(page, options, run) {
  const dedicated = await startDedicatedServer(options);
  try {
    await run({ handle: dedicated.handle, baseURL: dedicated.baseURL });
  } finally {
    await stopDedicatedServer(page, dedicated);
  }
}

/** POSTs directly to /api/auth/setup to create the owner outside the browser
 * (see auth.spec.js for the scenario that instead drives the real form). */
export async function createOwner(baseURL, passphrase) {
  const res = await fetch(`${baseURL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  if (res.status !== 201) throw new Error(`owner setup failed: ${res.status}`);
}

/** Expire only this isolated server's session after its browser shell is
 * fully ready. Avoids a tiny idle timeout racing WebKit startup while still
 * exercising the real 401/auth fallback path. */
export function expireIdleSessions(handle) {
  const result = handle.auth.db.prepare('UPDATE sessions SET last_seen_at = ?').run(new Date(0).toISOString());
  if (!result.changes) throw new Error('Expected an authenticated session to expire');
}
