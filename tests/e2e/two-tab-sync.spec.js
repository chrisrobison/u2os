import { test, expect } from '@playwright/test';
import { startDedicatedServer, stopDedicatedServer, createOwner } from './helpers.js';
import { proposeMemoryCandidate } from '../../server/memory/candidate-store.js';

// Issue #18: real-browser coverage of multi-client SSE fan-out -- a state
// change made in one authenticated browser tab reaches a second,
// independently-authenticated tab live, with no reload of tab B.
//
// ---- Scope correction versus the issue's literal wording ----
//
// The issue text (written before #16/#17 landed) suggested checking the
// chat transcript/status pill, #/memory's candidate list, AND the Activity
// timeline for the live update. Verified by reading the real client code
// (grep -rn "u2-event" public/components/*.js):
//
//   public/components/u2-timeline.js:79   window.addEventListener('u2-event', ...)
//   public/components/u2-timeline.js:96   window.removeEventListener('u2-event', ...)
//
// -- <u2-timeline> is the ONLY component anywhere under public/components/
// that subscribes to the live `u2-event` window CustomEvent bus
// (public/services/events.js's EventsService dispatches it). Specifically:
//
//   - <u2-agent>'s chat transcript/status pill (public/components/u2-agent.js)
//     never listens for 'u2-event' -- it only listens for its own
//     same-instance 'u2-action-resolved' DOM event, which an <u2-approval>
//     card dispatches when ITS OWN Approve/Cancel button is clicked
//     (u2-approval.js's _resolve()). That is pure same-tab, same-element-tree
//     wiring; nothing about it involves the SSE bus, so a second tab's
//     <u2-agent> instance can never reflect tab A's approval action live (or
//     at all, short of a fresh page load re-fetching whatever the pending
//     actions endpoint would return -- and per agent-approval.spec.js's own
//     header comment, no page/view even calls getPendingActions() today).
//     Not tested here -- it would be asserting behavior that was never
//     implemented.
//   - <u2-app>'s _renderMemory() (u2-app.js) fetches candidates once, on
//     render, via Promise.all([getMemoryEntities(), getMemoryCandidates()]);
//     it never subscribes to the event bus. A second tab already sitting on
//     #/memory does NOT drop a candidate's card live when another tab
//     accepts/rejects it -- confirmed a real, verified gap by reading the
//     method in full, not tested here as if it worked.
//   - <u2-timeline> (mounted at #/activity via u2-app.js's _renderActivity())
//     IS the real, live, SSE-driven, cross-tab-observable surface in this
//     codebase today: connectedCallback() self-fetches once, then stays live
//     by prepending every subsequent 'u2-event' it receives and re-rendering
//     (_onWindowEvent(), only active when `_standalone` -- i.e. no `events`
//     property was set by a parent, exactly u2-app.js's usage).
//
// This file scopes its two required scenarios (one action-approval, one
// memory-candidate, per the issue's acceptance criteria) to that one real
// surface: tab B sits on #/activity throughout, tab A drives the mutation,
// and the assertion is that tab B's <u2-timeline> gains the new event's
// humanized label live, with no reload of tab B in between.
//
// server/events/sse-hub.js's SseHub.broadcast() confirms the fan-out itself
// is faithful to a real multi-client scenario: it iterates `this.clients`
// (every currently-attached response, added in attach() regardless of which
// session opened the connection) and writes the same payload to all of
// them -- there is no per-owner/per-session filtering anywhere in it. Since
// U2OS is single-owner (one passphrase), two independently-logged-in
// contexts against the same dedicated server are simply two sessions
// belonging to the same owner (e.g. two devices/browsers) -- exactly what
// SseHub already fans out to indiscriminately.
const PASSPHRASE = 'correct horse battery staple';
const RESCHEDULE_MESSAGE = 'Move my 2 PM meeting with Sarah to tomorrow afternoon.';

async function loginFreshPage(browser, baseURL) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('u2-nav')).toBeVisible();
  return { context, page };
}

async function goToActivity(page) {
  await page.locator('u2-nav a[data-route="#/activity"]').click();
  await expect(page).toHaveURL(/#\/activity$/);
  await expect(page.locator('.workspace__title', { hasText: 'Activity' })).toBeVisible();
}

function timelineLabel(page, text) {
  return page.locator('u2-timeline .u2-timeline__label', { hasText: text }).first();
}

test.describe('multi-client SSE fan-out across two authenticated tabs (#18)', () => {
  test('tab A approving a pending action is reflected live in tab B\'s Activity timeline', async ({ browser }) => {
    const dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);

    // Two independent contexts (own cookie jars) logged in with the same
    // owner passphrase -- realistic "two devices/browsers, one owner", and
    // a faithful exercise of SseHub's session-agnostic broadcast().
    const tabA = await loginFreshPage(browser, dedicated.baseURL);
    const tabB = await loginFreshPage(browser, dedicated.baseURL);

    try {
      // Tab B sits on #/activity for the whole scenario -- <u2-agent> (the
      // chat panel) is mounted in the shell regardless of route (u2-app.js),
      // so tab A can drive the chat + approval from wherever its default
      // route lands (#/home) without ever navigating tab A away from the
      // agent panel.
      await goToActivity(tabB.page);
      await expect(tabA.page.locator('.agent-panel__input')).toBeVisible();

      // ---- Tab A: send the reschedule message -> pending calendar.reschedule ----
      await tabA.page.locator('.agent-panel__input').fill(RESCHEDULE_MESSAGE);
      await tabA.page.locator('.agent-panel__composer button[type="submit"]').click();
      await expect(tabA.page.locator('.chat-bubble.is-user').last()).toHaveText(RESCHEDULE_MESSAGE);

      const card = tabA.page.locator('.approval-list u2-approval').last();
      await expect(card).toHaveAttribute('data-status', 'pending');

      // agent.js's handleMessage() -> evaluateAndMaybeExecute() ->
      // ApprovalManager.recordDecision() publishes 'agent.action.proposed'
      // (EVENT_LABELS: "Proposed an action") the instant the message is
      // planned -- before any approval click. Tab B, sitting on #/activity
      // the whole time, must show it live without a reload.
      await expect(timelineLabel(tabB.page, 'Proposed an action')).toBeVisible();

      // ---- Tab A: approve it -> ApprovalManager.approve() publishes
      // 'agent.action.approved' ("You approved an action"), then
      // ActionExecutor.execute() publishes 'agent.action.completed'
      // ("Finished an action") in the same round trip (calendar.reschedule
      // has no override in policies.yaml -> falls to `confirm`, requiring
      // approval but executing immediately once approved). ----
      await card.locator('[data-action="approve"]').click();
      await expect(card).toHaveAttribute('data-status', 'executed');

      await expect(timelineLabel(tabB.page, 'You approved an action')).toBeVisible();
      await expect(timelineLabel(tabB.page, 'Finished an action')).toBeVisible();

      // Confirm tab B never reloaded to get here: its login-time SSE
      // connection is still the same one -- the URL is still #/activity
      // (a reload would still land there via hash persistence, but a
      // genuine navigation/reload would also re-trigger the u2-nav login
      // guard's initial fetch; more directly, u2-timeline's own live-merge
      // path only ever runs while `_standalone` stays true across the same
      // connectedCallback lifetime, which the two labels above already
      // prove happened without any explicit page.reload()/page.goto() call
      // on tab B anywhere in this test).
    } finally {
      await tabA.context.close();
      await tabB.context.close();
      await stopDedicatedServer(null, dedicated);
    }
  });

  test('tab A accepting a memory candidate is reflected live in tab B\'s Activity timeline', async ({ browser }) => {
    const dedicated = await startDedicatedServer();
    await createOwner(dedicated.baseURL, PASSPHRASE);

    const tabA = await loginFreshPage(browser, dedicated.baseURL);
    const tabB = await loginFreshPage(browser, dedicated.baseURL);

    try {
      await goToActivity(tabB.page);

      // No chat-driven trigger for memory candidates exists yet (verified
      // the same way memory-sse.spec.js's header comment documents: the
      // mock model provider's plan() never returns memoryCandidates, and
      // there is no direct-propose HTTP endpoint) -- seed one the same way,
      // by importing proposeMemoryCandidate() directly against the
      // dedicated server's own DB (same process, same U2OS_HOME).
      const content = 'Prefers async standups';
      proposeMemoryCandidate({ content, confidence: 'high', proposedBy: 'owner' });

      // ---- Tab A: accept it through the real #/memory form ----
      await tabA.page.locator('u2-nav a[data-route="#/memory"]').click();
      await expect(tabA.page).toHaveURL(/#\/memory$/);
      await expect(tabA.page.locator('.workspace__title', { hasText: 'Memory' })).toBeVisible();

      const memCard = tabA.page.locator('.dashboard-card', { hasText: content });
      await expect(memCard).toBeVisible();
      const chrisId = await memCard.locator('select[name="entityId"] option', { hasText: 'Chris' }).getAttribute('value');
      expect(chrisId).toBeTruthy();
      await memCard.locator('select[name="entityId"]').selectOption(chrisId);
      await memCard.locator('input[name="key"]').fill('standup_preference');
      await memCard.locator('button[type="submit"]').click();
      await expect(tabA.page.locator('.dashboard-card', { hasText: content })).toHaveCount(0);

      // POST /api/memory/candidates/:id/accept publishes 'memory.fact_recorded'
      // (EVENT_LABELS: "Remembered something new"). Tab B, parked on
      // #/activity this whole time with no reload, must pick it up live.
      await expect(timelineLabel(tabB.page, 'Remembered something new')).toBeVisible();
    } finally {
      await tabA.context.close();
      await tabB.context.close();
      await stopDedicatedServer(null, dedicated);
    }
  });
});
