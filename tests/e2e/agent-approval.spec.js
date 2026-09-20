import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';

// Issue #16: real-browser coverage of the chat UI (<u2-agent>, always
// mounted in the shell's <aside class="shell__agent"> on every route --
// see public/components/u2-app.js) and the inline approval-card flow
// (<u2-approval>, public/components/u2-approval.js).
//
// Deterministic intents driven through server/agent/mock-model-provider.js
// (verified by reading it, and cross-checked against the existing Node
// test tests/vertical-slice.test.js which exercises the same message):
//   - "Move my 2 PM meeting with Sarah to tomorrow afternoon." matches
//     RESCHEDULE_PATTERN against the seeded "Sync with Sarah" event and
//     proposes one calendar.reschedule action. calendar.reschedule has no
//     override in the default policies.yaml (server/policy/policies-loader.js),
//     so it falls through to `calendar.reschedule.default: confirm` --
//     status comes back 'pending', requiring approval.
//   - "Remind me to call the vet." matches REMINDER_PATTERN and proposes
//     one tasks.create action. tasks.create is `autonomous` in the same
//     default policy file, so server/agent/action-executor.js executes it
//     immediately inside the same request -- it comes back already
//     status: 'executed'.
//   - Anything else falls through to MockModelProvider.plan()'s final
//     branch: a fixed "I'm not sure how to help with ... yet" reasoning
//     summary and an empty actions[] array.
//
// getPendingActions()-unused gap (confirmed by reading, not assumed):
// `grep -rn "getPendingActions|actions/pending" public/` turns up exactly
// two hits -- the export itself in public/services/api.js (calling
// GET /api/actions/pending) and a comment in public/components/u2-approval.js
// documenting the "full" shape that endpoint (and GET /api/actions/:id)
// returns. No component or view anywhere under public/ ever calls
// getPendingActions() or renders its result -- there is currently no real
// page/view in the shipped UI that lists already-pending actions via that
// full shape. Scenario 6 below (the "already-pending/full-shape" case from
// issue #16) therefore cannot be exercised through a real page flow today;
// see that test's own comment for how it's covered honestly instead.
//
// Test isolation: unlike navigation.spec.js (read-only browsing, safe to
// share one server across every test), approving/rejecting a pending
// action here mutates real DB state (the calendar event's start/end time,
// the agent_actions row's terminal status). Tests 1, 2, 5 and 6 below share
// one dedicated server + one logged-in page in a describe.serial block
// (in the style of navigation.spec.js) because they either don't mutate
// shared state at all (1, 5 -- tasks.create is a brand new row each time)
// or only *create* a pending action without resolving it further (2, 6 --
// 6 reads that same still-pending action's full shape via a direct fetch,
// which is read-only). Test 3 (approve) deliberately resolves the exact
// pending action test 2 created, continuing the same shared session, since
// it needs that real card's Approve button. Test 4 (reject) gets its OWN
// fresh dedicated server rather than reusing the shared one: by the time
// test 3 finishes, the shared server's one seeded "Sarah" calendar event
// has already been rescheduled (executed), and reusing that mutated
// server for a second, independent reschedule-then-reject flow would mean
// test 4's outcome depends on exactly what test 3 did to the calendar
// first -- a fresh server sidesteps that coupling entirely rather than
// relying on the mock planner's candidate selection still behaving the
// same way against an already-moved event.
const PASSPHRASE = 'correct horse battery staple';
const RESCHEDULE_MESSAGE = 'Move my 2 PM meeting with Sarah to tomorrow afternoon.';
const REMINDER_MESSAGE = 'Remind me to call the vet.';

async function loginFreshPage(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('u2-nav')).toBeVisible();
  await expect(page.locator('.agent-panel__input')).toBeVisible();
  return { context, page };
}

test.describe.serial('agent chat + inline approval flow (#16)', () => {
  let dedicated;
  let context;
  let page;
  let rescheduleActionId;

  test.beforeAll(async ({ browser }) => {
    dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);
    ({ context, page } = await loginFreshPage(browser, dedicated.baseURL));
  });

  test.afterAll(async () => {
    await context?.close();
    await stopDedicatedServer(null, dedicated);
  });

  async function sendChat(text) {
    await page.locator('.agent-panel__input').fill(text);
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText(text);
  }

  // ---- 1. plain chat request -> response renders, no actions ----

  test('an unrecognized message renders the agent\'s reasoning summary with no approval card', async () => {
    const before = await page.locator('.approval-list u2-approval').count();
    const message = 'Tell me a joke about spreadsheets.';

    await sendChat(message);

    const agentBubble = page.locator('.chat-bubble.is-agent').last();
    await expect(agentBubble).toBeVisible();
    await expect(agentBubble).toContainText(`I'm not sure how to help with "${message}" yet`);

    // No new approval card was appended for this turn.
    await expect(page.locator('.approval-list u2-approval')).toHaveCount(before);
  });

  // ---- 2. chat request producing a pending action -> inline approval card ----

  test('the reschedule message renders a pending inline <u2-approval> card with Approve/Cancel', async () => {
    await sendChat(RESCHEDULE_MESSAGE);

    const agentBubble = page.locator('.chat-bubble.is-agent').last();
    await expect(agentBubble).toContainText('Proposing to move it');

    const card = page.locator('.approval-list u2-approval').last();
    await expect(card).toHaveAttribute('data-status', 'pending');
    await expect(card.locator('.u2-approval__title')).toContainText('reschedule a calendar event');
    await expect(card.locator('[data-action="approve"]')).toBeVisible();
    await expect(card.locator('[data-action="approve"]')).toHaveText('Approve');
    await expect(card.locator('[data-action="reject"]')).toBeVisible();
    await expect(card.locator('[data-action="reject"]')).toHaveText('Cancel');
    // No resolved-status span while pending.
    await expect(card.locator('.u2-approval__status')).toHaveCount(0);

    rescheduleActionId = await card.evaluate((el) => el.action.id);
    expect(rescheduleActionId).toBeTruthy();
  });

  // ---- 6. "already-pending/full-shape" scenario -----------------------
  //
  // Per the header comment's recon: no real page/view under public/ ever
  // calls getPendingActions() (GET /api/actions/pending) or renders its
  // "full" shape ({ id, requested_by, request_text, model, tool,
  // arguments, reasoning_summary, policy_domain, policy_rule,
  // autonomy_level, requires_approval, status, approved_by, approved_at,
  // result, correlation_id, created_at, updated_at }) -- so there is no
  // real user-facing flow this test could drive to exercise it. Instead,
  // this exercises the REAL, shipped <u2-approval> component directly: it
  // fetches the actual full-shape row for the still-pending action test 2
  // just created (a real GET /api/actions/:id round trip, not a
  // hand-fabricated object), then hands that real data to a freshly
  // created <u2-approval> element via `.action =` -- the exact same setter
  // public/components/u2-agent.js itself uses -- and asserts the
  // component renders the full shape identically to the inline shape
  // (pending status, Approve/Cancel visible). This is real component
  // coverage, just not reached through a page flow, because that page
  // flow doesn't exist yet in the app.
  test('the real <u2-approval> component renders the full GET /api/actions/:id shape identically to the inline shape', async () => {
    expect(rescheduleActionId).toBeTruthy();

    const fullShape = await page.evaluate(async (id) => {
      const res = await fetch(`/api/actions/${id}`);
      return res.json();
    }, rescheduleActionId);

    expect(fullShape.id).toBe(rescheduleActionId);
    expect(fullShape.status).toBe('pending');
    expect(fullShape.tool).toBe('calendar.reschedule');
    // Full-shape-only fields absent from the inline shape -- confirms this
    // really is the "full" row, not a re-fetch of the inline object.
    expect(fullShape.requested_by).toBeTruthy();
    expect(fullShape.policy_domain).toBeTruthy();

    await page.evaluate((shape) => {
      const el = document.createElement('u2-approval');
      el.id = 'e2e-full-shape-probe';
      document.body.appendChild(el);
      el.action = shape;
    }, fullShape);

    const probe = page.locator('#e2e-full-shape-probe');
    await expect(probe).toHaveAttribute('data-status', 'pending');
    await expect(probe.locator('.u2-approval__title')).toContainText('reschedule a calendar event');
    await expect(probe.locator('[data-action="approve"]')).toBeVisible();
    await expect(probe.locator('[data-action="reject"]')).toBeVisible();
    await expect(probe.locator('.u2-approval__status')).toHaveCount(0);

    // Clean up the detached probe element -- it lives outside <u2-agent>'s
    // own transcript and must not leak into later tests/screenshots.
    await probe.evaluate((el) => el.remove());
  });

  // ---- 3. approve the pending action -> real server round trip executes it ----

  test('approving the pending action executes it and reflects the real server round trip', async () => {
    // NOTE: this locator deliberately does NOT filter on `[data-status="pending"]`
    // -- Playwright locators re-run their selector on every use, and this
    // card's own data-status attribute is about to flip to "executed" below.
    // A status-filtered locator would then match nothing and every
    // subsequent assertion on `card` would fail with "element(s) not found".
    // Positional identity (.last(), no later card is appended in this test)
    // stays stable across that mutation, so it's used instead.
    const card = page.locator('.approval-list u2-approval').last();
    await expect(card).toHaveAttribute('data-status', 'pending');
    const cardActionId = await card.evaluate((el) => el.action.id);
    expect(cardActionId).toBe(rescheduleActionId);

    await card.locator('[data-action="approve"]').click();

    await expect(card).toHaveAttribute('data-status', 'executed');
    await expect(card.locator('.u2-approval__status')).toHaveText('Approved and done');
    await expect(card.locator('[data-action="approve"]')).toHaveCount(0);
    await expect(card.locator('[data-action="reject"]')).toHaveCount(0);

    // u2-action-resolved bubbled up to <u2-agent>, which appended the
    // DONE_LABELS['calendar.reschedule'] system bubble.
    await expect(page.locator('.chat-bubble.is-system').last()).toHaveText('Done. Rescheduled.');

    // Confirm against the REAL server, not just the UI's optimistic state:
    // the DB row itself is now status=executed with a real result.
    const serverRow = await page.evaluate(async (id) => {
      const res = await fetch(`/api/actions/${id}`);
      return res.json();
    }, rescheduleActionId);
    expect(serverRow.status).toBe('executed');
    expect(serverRow.result).toBeTruthy();
  });

  // ---- 5. autonomous action -> renders already-resolved, no approve/reject ever ----

  test('the reminder message renders an already-executed <u2-approval> card with no approve/reject buttons', async () => {
    await sendChat(REMINDER_MESSAGE);

    const agentBubble = page.locator('.chat-bubble.is-agent').last();
    await expect(agentBubble).toContainText('Creating a task so you don\'t forget');

    const card = page.locator('.approval-list u2-approval').last();
    // Autonomous: already resolved the instant it's rendered -- unlike
    // tests 2-4's pending case, Approve/Cancel must never appear at all.
    await expect(card).toHaveAttribute('data-status', 'executed');
    await expect(card.locator('.u2-approval__title')).toContainText('create a task');
    await expect(card.locator('.u2-approval__status')).toHaveText('Approved and done');
    await expect(card.locator('[data-action="approve"]')).toHaveCount(0);
    await expect(card.locator('[data-action="reject"]')).toHaveCount(0);

    // Note: unlike the approve-button path (test 3), an already-resolved
    // card rendered straight from the server response never calls
    // u2-approval.js's _resolve() (that's the only place that dispatches
    // u2-action-resolved), so <u2-agent> never appends a "Done." system
    // bubble for an autonomous action -- there is deliberately no such
    // assertion here.
  });
});

// ---- 4. reject a pending action -- fresh dedicated server (see header
// comment for why this doesn't reuse the block above's server). ----

test('rejecting a pending action cancels it without executing, confirmed against the real server', async ({ browser }) => {
  const dedicated = await startDedicatedServer();
  await createOwner(dedicated.baseURL, PASSPHRASE);
  const { context, page } = await loginFreshPage(browser, dedicated.baseURL);

  try {
    await page.locator('.agent-panel__input').fill(RESCHEDULE_MESSAGE);
    await page.locator('.agent-panel__composer button[type="submit"]').click();
    await expect(page.locator('.chat-bubble.is-user').last()).toHaveText(RESCHEDULE_MESSAGE);

    // Same reasoning as the approve test above: no `[data-status="pending"]`
    // filter, since this card's status attribute is about to change.
    const card = page.locator('.approval-list u2-approval').last();
    await expect(card).toHaveAttribute('data-status', 'pending');
    const actionId = await card.evaluate((el) => el.action.id);
    expect(actionId).toBeTruthy();

    await card.locator('[data-action="reject"]').click();

    await expect(card).toHaveAttribute('data-status', 'rejected');
    await expect(card.locator('.u2-approval__status')).toHaveText('Cancelled');
    await expect(card.locator('[data-action="approve"]')).toHaveCount(0);
    await expect(card.locator('[data-action="reject"]')).toHaveCount(0);

    await expect(page.locator('.chat-bubble.is-system').last()).toHaveText('Cancelled.');

    // Confirm against the REAL server: rejected, never executed --
    // ApprovalManager.reject() (server/agent/approval-manager.js) never
    // calls the action executor, so `result` must still be null/absent.
    const serverRow = await page.evaluate(async (id) => {
      const res = await fetch(`/api/actions/${id}`);
      return res.json();
    }, actionId);
    expect(serverRow.status).toBe('rejected');
    expect(serverRow.result == null).toBe(true);
  } finally {
    // Close the context first (like navigation.spec.js's afterAll) so the
    // browser ends its SSE/WebSocket connections cleanly on its own, then
    // stop the server with page=null -- no page left to navigate away.
    await context.close();
    await stopDedicatedServer(null, dedicated);
  }
});
