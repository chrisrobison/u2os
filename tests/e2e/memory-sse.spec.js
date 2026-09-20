import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { proposeMemoryCandidate } from '../../server/memory/candidate-store.js';

// Issue #17: real-browser coverage of (a) the memory-candidate accept/reject
// flow (<u2-app>'s _renderMemory(), public/components/u2-app.js around line
// 417) and (b) the SSE client's live-update/reconnect/recovery behavior
// (public/services/events.js's EventsService, server/events/sse-hub.js).
//
// ---- No chat-driven trigger for memory candidates exists yet ----
//
// Verified by reading server/agent/mock-model-provider.js's plan(): it only
// ever returns { reasoning_summary, actions } -- never memoryCandidates --
// and grepping server/api/routes/memory.js shows no endpoint to directly
// propose one (only GET /api/memory/candidates and the accept/reject POSTs).
// The only code path that ever inserts a `memory_candidates` row is
// server/agent/agent.js calling proposeMemoryCandidate()
// (server/memory/candidate-store.js) when a model's plan actually includes
// one -- which MockModelProvider never does. So, mirroring how
// agent-approval.spec.js documented its own getPendingActions()-unused gap,
// this file seeds pending candidates by importing proposeMemoryCandidate
// directly and calling it in-process against the dedicated server's own DB
// (same process, same U2OS_HOME as set by startDedicatedServer() -- see
// server/db/connection.js's getDb(), which re-reads process.env.U2OS_HOME
// on every call and keys its connection cache by the resulting db path, so
// this call transparently shares the exact same SQLite connection the
// running dedicated server is using). This is real production code
// (candidate-store.js) exercised for real, just via direct import rather
// than through a chat message, because no chat-driven path exists yet.
//
// ---- /api/events/stream auth-protection assumption, verified not assumed ----
//
// tests/auth.test.js:59 already asserts `/api/events/stream` 401s with an
// expired-but-cookied session, and line 24 asserts a family of protected
// GETs 401 pre-auth. Reading server/api/router.js's Router.handle()
// confirms why: PUBLIC only lists health/auth-status/setup/login/logout;
// every other route -- '/api/events/stream' registered in
// server/api/routes/events.js via the same `router` as everything else --
// goes through the same `if (this.auth && !PUBLIC.has(...) && !req.session)
// return sendJson(res, 401, ...)` gate. There is no separate/parallel auth
// check for SSE; it is the exact same router-level session middleware.
//
// ---- Test isolation ----
//
// Tests 1 and 2 (accept/reject) share one dedicated server + logged-in page
// (describe.serial, agent-approval.spec.js's pattern): each seeds its OWN
// fresh candidate and only touches that candidate's own card/fact, so they
// don't corrupt each other's assertions despite sharing DB state.
//
// The SSE tests (3-5) get their own dedicated server + page, serial among
// themselves: test 4's forced reconnect and test 5's Last-Event-ID capture
// are deliberately chained onto the SAME live EventsService instance/page
// (not a reload) -- a page reload would construct a brand-new EventsService
// with `_lastEventId` reset to null, which would make it impossible to
// prove the *live* client recovers its own connection and correctly
// remembers the last id it saw. Test 3 (live update) runs first in that
// block specifically so tests 4/5 have a real "received before the drop"
// event already in hand.
//
// Test 6 (session expiry) needs its own dedicated server with a short
// sessionIdleSeconds (mirrors auth.spec.js's 0.05 pattern), which per that
// file's own rationale must never be applied to a server shared with any
// other scenario.
//
// ---- How the connection-drop is simulated (tests 4/5/6) ----
//
// The issue text suggests `page.route('**/api/events/stream', route =>
// route.abort())`, but Playwright route interception only applies at
// request-dispatch time -- it cannot reach into an already-open, actively
// streaming fetch() response body, which is exactly what EventsService
// holds once connected. To actually sever a *live* SSE connection while
// keeping the same page/JS heap (so `_lastEventId` survives), this uses
// direct Node access instead (same process, same spirit as seeding
// candidates above, and the same primitive tests/e2e/helpers.js's own
// stopDedicatedServer() already uses for teardown):
// `dedicated.handle.server.closeAllConnections()` forcibly destroys the
// live socket, which makes the browser's in-flight `reader.read()` settle
// with an error/close, driving EventsService._run() into its catch branch
// and its retry-with-backoff loop exactly as a real dropped connection
// would. On top of that, test 4 also layers a `page.route(...)` that
// aborts exactly once (then immediately unroutes itself, per the issue's
// own "or intercept only once ... followed immediately by page.unroute()"
// fallback) so the FIRST reconnect attempt after the drop also fails,
// proving the backoff loop survives more than one consecutive failure
// before recovering.
const PASSPHRASE = 'correct horse battery staple';

async function loginFreshPage(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('u2-nav')).toBeVisible();
  return { context, page };
}

async function goToMemory(page) {
  await page.locator('u2-nav a[data-route="#/memory"]').click();
  await expect(page).toHaveURL(/#\/memory$/);
  await expect(page.locator('.workspace__title', { hasText: 'Memory' })).toBeVisible();
}

// ---------------------------------------------------------------------
// 1 & 2: memory candidate accept / reject, driven through the real
// <u2-app> markup described in the issue (form.dashboard-card with
// select[name=entityId] / input[name=key] / submit + [data-reject]).
// ---------------------------------------------------------------------

test.describe.serial('memory candidate accept/reject flow (#17)', () => {
  let dedicated;
  let context;
  let page;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    ({ context, page } = await loginFreshPage(browser, dedicated.baseURL));
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  test('accepting a pending candidate creates a fact visible on the entity detail view', async () => {
    const content = 'Prefers afternoon meetings';
    proposeMemoryCandidate({ content, confidence: 'high', proposedBy: 'owner' });

    await goToMemory(page);

    const card = page.locator('.dashboard-card', { hasText: content });
    await expect(card).toBeVisible();
    await expect(card.locator('p')).toHaveText(content);

    const chrisOption = card.locator('select[name="entityId"] option', { hasText: 'Chris' });
    await expect(chrisOption).toHaveCount(1);
    const chrisId = await chrisOption.getAttribute('value');
    expect(chrisId).toBeTruthy();

    await card.locator('select[name="entityId"]').selectOption(chrisId);
    await card.locator('input[name="key"]').fill('preferred_meeting_time');
    await card.locator('button[type="submit"]').click();

    // Submitting re-renders _renderMemory(): the card for this candidate is
    // gone (accepted candidates are no longer 'pending').
    await expect(page.locator('.dashboard-card', { hasText: content })).toHaveCount(0);

    // Navigate to Chris's entity detail and confirm the new fact renders
    // with the exact humanized key (see util.js's humanizeKey:
    // "preferred_meeting_time" -> "Preferred meeting time"), the candidate's
    // content as the JSON-stringified value, and the real
    // memory-candidate-confirmation provenance/confidence
    // (confidenceNumber('high') === 0.95 -> "confidence 95%").
    await page.locator('.entity-row__name', { hasText: 'Chris' }).click();
    await expect(page).toHaveURL(new RegExp(`#/memory/${chrisId}$`));

    const factRow = page.locator('.fact-row', { hasText: 'Preferred meeting time' });
    await expect(factRow).toBeVisible();
    await expect(factRow).toContainText('Preferred meeting time:');
    await expect(factRow).toContainText(`"${content}"`);
    await expect(factRow).toContainText('memory-candidate-confirmation');
    await expect(factRow).toContainText('confidence 95%');
  });

  test('rejecting a pending candidate removes it without creating a fact', async () => {
    const content = 'Dislikes video calls after 5pm';
    proposeMemoryCandidate({ content, confidence: 'medium', proposedBy: 'owner' });

    await goToMemory(page);

    const card = page.locator('.dashboard-card', { hasText: content });
    await expect(card).toBeVisible();

    await card.locator('[data-reject]').click();

    // Re-rendered: the rejected candidate's card is gone.
    await expect(page.locator('.dashboard-card', { hasText: content })).toHaveCount(0);

    // Confirm no fact was created anywhere for it: revisit Chris's detail
    // page (already has test 1's real fact, so it is NOT in the
    // "No facts recorded yet" empty state) and confirm this rejected
    // candidate's content never shows up among the rendered facts.
    await goToMemory(page);
    await page.locator('.entity-row__name', { hasText: 'Chris' }).click();
    await expect(page.locator('.entity-detail__section-title', { hasText: 'Facts' })).toBeVisible();
    await expect(page.locator('.fact-row', { hasText: content })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------
// 3, 4, 5: SSE live update, forced reconnect, and Last-Event-ID
// recovery/dedup -- all against one shared page/EventsService instance
// (see file header for why no reload happens between them).
// ---------------------------------------------------------------------

test.describe.serial('SSE live update, reconnect, and recovery (#17)', () => {
  let dedicated;
  let context;
  let page;
  let streamRequests;
  let beforeDropLastEvent;
  let reconnectRequest;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    ({ context, page } = await loginFreshPage(browser, dedicated.baseURL));

    // Window-scoped sink for every 'u2-event' CustomEvent the real
    // EventsService dispatches -- the documented hook point (per
    // events.js's own header comment) rather than sniffing the raw network
    // stream. Recorded as {id, type} pairs so later tests can check for
    // exact-duplicate delivery.
    await page.evaluate(() => {
      window.__u2Events = [];
      window.addEventListener('u2-event', (e) => {
        window.__u2Events.push({ id: e.detail?.id, type: e.detail?.type });
      });
    });

    // Collects every request this page makes to the stream endpoint from
    // here on (the initial connect made during loginFreshPage's shell
    // render already happened before this listener attaches -- fine, since
    // tests 4/5 only care about later reconnect requests).
    streamRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/events/stream')) streamRequests.push(req);
    });
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  test('a real server-side event reaches the page live via the u2-event bus', async () => {
    // Accepting a memory candidate publishes a real 'memory.fact_recorded'
    // event (server/api/routes/memory.js) -- exercised through the actual
    // UI flow, not a raw fetch, so this is a real client round trip.
    const content = 'Prefers written status updates';
    proposeMemoryCandidate({ content, confidence: 'high', proposedBy: 'owner' });

    await goToMemory(page);
    const card = page.locator('.dashboard-card', { hasText: content });
    await expect(card).toBeVisible();
    const chrisId = await card.locator('select[name="entityId"] option', { hasText: 'Chris' }).getAttribute('value');
    await card.locator('select[name="entityId"]').selectOption(chrisId);
    await card.locator('input[name="key"]').fill('status_update_channel');
    await card.locator('button[type="submit"]').click();
    await expect(page.locator('.dashboard-card', { hasText: content })).toHaveCount(0);

    await expect
      .poll(() => page.evaluate(() => window.__u2Events.some((e) => e.type === 'memory.fact_recorded')))
      .toBe(true);

    // Also confirm the OTHER documented live surface -- #/activity's
    // u2-timeline -- shows the same event without a reload.
    await page.locator('u2-nav a[data-route="#/activity"]').click();
    await expect(page.locator('u2-timeline .u2-timeline__label', { hasText: 'Remembered something new' }).first()).toBeVisible();

    beforeDropLastEvent = await page.evaluate(() => window.__u2Events[window.__u2Events.length - 1]);
    expect(beforeDropLastEvent?.id).toBeTruthy();
    expect(beforeDropLastEvent?.type).toBe('memory.fact_recorded');
  });

  test('the client recovers after a forced connection drop, surviving one failed reconnect attempt', async () => {
    let aborted = false;
    await page.route('**/api/events/stream', async (route) => {
      if (!aborted) {
        aborted = true;
        await route.abort();
        await page.unroute('**/api/events/stream');
      } else {
        await route.continue();
      }
    });

    // Sever the currently-open SSE connection server-side (see file header
    // for why this uses direct Node access rather than route interception,
    // which cannot reach an already-open streaming response).
    dedicated.handle.server.closeAllConnections();

    // Wait for a reconnect request that carries the real last-received
    // event's id as Last-Event-ID -- budgets real time for the forced
    // failure's own backoff (starts at 1000ms, doubles to 2000ms after the
    // aborted attempt) rather than racing it with a fixed sleep.
    reconnectRequest = await page.waitForRequest(
      (req) => req.url().includes('/api/events/stream') && req.headers()['last-event-id'] === String(beforeDropLastEvent.id),
      { timeout: 15000 }
    );

    // Confirm the connection actually came back up and is live: a brand
    // new real event still arrives after the drop + backoff window,
    // reusing the reject flow (publishes 'agent.memory_candidate.rejected')
    // so no extra UI round trip is needed beyond a button click.
    const content = 'Dislikes early morning calls';
    proposeMemoryCandidate({ content, confidence: 'low', proposedBy: 'owner' });
    await goToMemory(page);
    const card = page.locator('.dashboard-card', { hasText: content });
    await expect(card).toBeVisible();
    await card.locator('[data-reject]').click();
    await expect(card).toHaveCount(0);

    await expect
      .poll(() => page.evaluate(() => window.__u2Events.some((e) => e.type === 'agent.memory_candidate.rejected')))
      .toBe(true);
  });

  test('the reconnect Last-Event-ID matches the real prior event, with no duplicate delivery', async () => {
    expect(reconnectRequest).toBeTruthy();
    expect(reconnectRequest.headers()['last-event-id']).toBe(String(beforeDropLastEvent.id));

    // At least one of the requests this page made to the stream endpoint
    // during/after the drop really did carry the id -- corroborates the
    // targeted waitForRequest above against the full captured set.
    expect(streamRequests.some((req) => req.headers()['last-event-id'] === String(beforeDropLastEvent.id))).toBe(true);

    // The pre-drop event must not have been re-delivered after the
    // reconnect's replay: server/events/sse-hub.js's attach() only replays
    // events with a strictly higher id (listEventsAfterId's `rowid >
    // cursor.sequence`), so the event that WAS the Last-Event-ID itself is
    // never resent -- confirm the client's received log agrees, exactly
    // one entry for that id/type pair, not two.
    const matches = await page.evaluate(
      ({ id, type }) => window.__u2Events.filter((e) => e.id === id && e.type === type).length,
      beforeDropLastEvent
    );
    expect(matches).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 6: an idle-expired session stops the retry loop from ever succeeding
// again, cleanly (401s forever, no uncaught exception) -- own dedicated
// server with a short sessionIdleSeconds (see file header for why).
// ---------------------------------------------------------------------

test('an idle-expired session makes /api/events/stream 401 without an uncaught retry-loop exception', async ({ browser }) => {
  const dedicated = await startDedicatedServer({ sessionIdleSeconds: 0.05 });
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  try {
    await page.goto(dedicated.baseURL);
    await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator('u2-nav')).toBeVisible();

    // Let the 50ms idle window lapse (mirrors auth.spec.js's own
    // sessionIdleSeconds: 0.05 pattern) with no further requests from this
    // page.
    await page.waitForTimeout(200);

    // The already-open SSE connection from page load stays open regardless
    // of server-side session state (attach() only checks auth once, at
    // connect time) -- force it closed so the client's retry loop makes a
    // brand NEW connection attempt, which now hits the expired session.
    dedicated.handle.server.closeAllConnections();

    const firstUnauthorized = await page.waitForResponse(
      (res) => res.url().includes('/api/events/stream') && res.status() === 401,
      { timeout: 15000 }
    );
    expect(firstUnauthorized.status()).toBe(401);

    // events.js's retry loop is designed to log-and-retry forever (its own
    // console.error + backoff, never a throw) -- confirm a SECOND 401
    // arrives too (it kept looping, not stopped or hung), and that nothing
    // escaped as an uncaught page exception the whole time.
    const secondUnauthorized = await page.waitForResponse(
      (res) => res.url().includes('/api/events/stream') && res.status() === 401,
      { timeout: 15000 }
    );
    expect(secondUnauthorized.status()).toBe(401);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
