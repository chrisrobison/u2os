import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { recordFeedback } from '../server/feedback/feedback-store.js';
import { scoreForSuggestion, MAX_ADJUSTMENT } from '../server/feedback/prioritizer.js';
import { policiesPath, ensureDefaultPolicies } from '../server/policy/policies-loader.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

function tempHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  return dir;
}

async function cleanupServer(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function cleanupDirect(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildAgent({ policyEngine } = {}) {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const toolRegistry = createToolRegistry();
  const modelProvider = new MockModelProvider();
  const agent = new Agent({
    modelProvider,
    policyEngine: policyEngine || new PolicyEngine(),
    toolRegistry,
    eventBus,
    ownerEntityId,
  });
  return { db, eventBus, agent, ownerEntityId };
}

async function postJson(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function getJson(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// --- POST /api/actions/:id/approve|reject also write feedback_events -----

test('POST /api/actions/:id/approve writes an "accepted" feedback_events row, unchanged response shape', async () => {
  const dir = tempHome('u2os-feedback-approve-');
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const agentRes = await postJson(port, '/api/agent/message', {
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
    });
    const proposed = agentRes.json.actions[0];
    assert.equal(proposed.status, 'pending');

    const approve = await postJson(port, `/api/actions/${proposed.id}/approve`, { approvedBy: 'user' });
    assert.equal(approve.status, 200);
    assert.equal(approve.json.status, 'executed'); // existing response shape untouched

    const feedback = await getJson(port, `/api/feedback?subjectType=agent_action&subjectId=${proposed.id}`);
    assert.equal(feedback.status, 200);
    assert.equal(feedback.json.feedback.length, 1);
    const row = feedback.json.feedback[0];
    assert.equal(row.subject_type, 'agent_action');
    assert.equal(row.subject_id, proposed.id);
    assert.equal(row.outcome, 'accepted');
    assert.equal(row.detail.tool, 'calendar.reschedule');
    assert.equal(row.correlation_id, agentRes.json.correlationId);
  } finally {
    await cleanupServer(dir, handle);
  }
});

test('POST /api/actions/:id/reject writes a "rejected" feedback_events row, unchanged response shape', async () => {
  const dir = tempHome('u2os-feedback-reject-');
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const agentRes = await postJson(port, '/api/agent/message', {
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
    });
    const proposed = agentRes.json.actions[0];

    const reject = await postJson(port, `/api/actions/${proposed.id}/reject`, { rejectedBy: 'user' });
    assert.equal(reject.status, 200);
    assert.equal(reject.json.status, 'rejected');

    const feedback = await getJson(port, `/api/feedback?subjectType=agent_action&subjectId=${proposed.id}`);
    assert.equal(feedback.json.feedback.length, 1);
    assert.equal(feedback.json.feedback[0].outcome, 'rejected');
  } finally {
    await cleanupServer(dir, handle);
  }
});

// --- POST /api/feedback ----------------------------------------------------

test('POST /api/feedback validates subjectType/subjectId/outcome (400s) and works for dashboard_card/notification', async () => {
  const dir = tempHome('u2os-feedback-post-');
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const missingSubjectType = await postJson(port, '/api/feedback', { subjectId: 'x', outcome: 'dismissed' });
    assert.equal(missingSubjectType.status, 400);

    const invalidSubjectType = await postJson(port, '/api/feedback', { subjectType: 'bogus', subjectId: 'x', outcome: 'dismissed' });
    assert.equal(invalidSubjectType.status, 400);

    const missingSubjectId = await postJson(port, '/api/feedback', { subjectType: 'dashboard_card', outcome: 'dismissed' });
    assert.equal(missingSubjectId.status, 400);

    const invalidOutcome = await postJson(port, '/api/feedback', { subjectType: 'dashboard_card', subjectId: 'card_1', outcome: 'bogus' });
    assert.equal(invalidOutcome.status, 400);

    const dashboardCard = await postJson(port, '/api/feedback', {
      subjectType: 'dashboard_card',
      subjectId: 'card_1',
      outcome: 'dismissed',
      detail: { reason: 'not relevant' },
    });
    assert.equal(dashboardCard.status, 200);
    assert.equal(dashboardCard.json.feedback.subject_type, 'dashboard_card');
    assert.equal(dashboardCard.json.feedback.outcome, 'dismissed');
    assert.equal(dashboardCard.json.feedback.detail.reason, 'not relevant');

    const notification = await postJson(port, '/api/feedback', {
      subjectType: 'notification',
      subjectId: 'notif_1',
      outcome: 'marked_useful',
    });
    assert.equal(notification.status, 200);
    assert.equal(notification.json.feedback.outcome, 'marked_useful');

    const listed = await getJson(port, '/api/feedback');
    assert.ok(listed.json.feedback.length >= 2);
  } finally {
    await cleanupServer(dir, handle);
  }
});

test('POST /api/feedback for a recommendation dismiss also updates the recommendation status via the same status-update path PATCH /api/recommendations/:id uses', async () => {
  const dir = tempHome('u2os-feedback-rec-');
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    // Query directly rather than through /api/calendar/events' time-window
    // filtering, which is timing-sensitive (today's 2pm seed event could
    // fall outside its "upcoming" window depending on when the test runs).
    const syncWithSarah = getDb().prepare("SELECT * FROM calendar_events WHERE title = 'Sync with Sarah'").get();
    assert.ok(syncWithSarah);

    // Drive the calendar.event_approaching -> 'prepare' recommendation
    // directly through the running server's own agent instance (same
    // decision path tests/proactive-agent.test.js exercises) -- there is no
    // HTTP route that triggers evaluateEvent() on demand, so this reaches
    // through handle.agent exactly like the trigger engine's polled half
    // would call it internally.
    const evalResult = await handle.agent.evaluateEvent({
      type: 'calendar.event_approaching',
      data: { eventId: syncWithSarah.id, minutesUntil: 30 },
      subject: { type: 'calendar_event', id: syncWithSarah.id },
    });
    assert.equal(evalResult.decision, 'prepare');
    const recommendationId = evalResult.recommendation.id;
    assert.ok(recommendationId, 'expected a recommendation to have been created');

    const before = await getJson(port, `/api/recommendations/${recommendationId}`);
    assert.equal(before.json.status, 'open');

    const dismiss = await postJson(port, '/api/feedback', {
      subjectType: 'recommendation',
      subjectId: recommendationId,
      outcome: 'dismissed',
    });
    assert.equal(dismiss.status, 200);
    assert.equal(dismiss.json.recommendation.status, 'dismissed');

    const after = await getJson(port, `/api/recommendations/${recommendationId}`);
    assert.equal(after.json.status, 'dismissed');

    const feedbackRows = await getJson(port, `/api/feedback?subjectType=recommendation&subjectId=${recommendationId}`);
    assert.equal(feedbackRows.json.feedback[0].outcome, 'dismissed');
  } finally {
    await cleanupServer(dir, handle);
  }
});

// --- Auto-detected email edit-before-send ----------------------------------

test('email.draft -> email.send with an explicit draftId and different content records outcome "edited"', async () => {
  const dir = tempHome('u2os-feedback-edit-');
  try {
    const { agent, db } = buildAgent();
    const correlationId = 'corr_same_turn_test';
    const actor = { type: 'user', id: 'user' };

    const draftOutcome = await agent.evaluateAndMaybeExecute({
      tool: 'email.draft',
      arguments: { to: 'sarah@example.com', subject: 'Draft subject', body: 'Draft body text' },
      requestedBy: 'user',
      requestText: 'draft an email',
      correlationId,
      actor,
    });
    const draftId = draftOutcome.result.id;

    // email.send has no policy `default` sub-category and agent.js's
    // _buildEvalContext only derives a category for calendar.reschedule --
    // so this always falls back to `confirm` (pending), never straight to
    // 'executed', regardless of the `to` address. Approve it explicitly to
    // reach the same _execute() path a real approval would.
    const sendProposal = await agent.evaluateAndMaybeExecute({
      tool: 'email.send',
      arguments: { to: 'sarah@example.com', subject: 'Edited subject', body: 'Draft body text', draftId },
      requestedBy: 'user',
      requestText: 'send it',
      correlationId,
      actor,
    });
    assert.equal(sendProposal.status, 'pending');
    const sendOutcome = await agent.approveAction(sendProposal.id, 'user');
    assert.equal(sendOutcome.status, 'executed');

    const rows = db
      .prepare("SELECT * FROM feedback_events WHERE subject_type = 'agent_action' AND subject_id = ? AND outcome = 'edited'")
      .all(sendOutcome.id);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail);
    assert.deepEqual(detail.editedFields.sort(), ['subject']);
    assert.equal(detail.tool, 'email.send');
    assert.equal(detail.domain, 'email');
  } finally {
    cleanupDirect(dir);
  }
});

test('email.draft -> email.send with an explicit draftId but identical content records no "edited" feedback', async () => {
  const dir = tempHome('u2os-feedback-noedit-');
  try {
    const { agent, db } = buildAgent();
    const correlationId = 'corr_same_turn_no_edit';
    const actor = { type: 'user', id: 'user' };

    const draftOutcome = await agent.evaluateAndMaybeExecute({
      tool: 'email.draft',
      arguments: { to: 'sarah@example.com', subject: 'Same subject', body: 'Same body' },
      requestedBy: 'user',
      correlationId,
      actor,
    });
    const draftId = draftOutcome.result.id;
    const sendProposal = await agent.evaluateAndMaybeExecute({
      tool: 'email.send',
      arguments: { to: 'sarah@example.com', subject: 'Same subject', body: 'Same body', draftId },
      requestedBy: 'user',
      correlationId,
      actor,
    });
    const sendOutcome = await agent.approveAction(sendProposal.id, 'user');
    assert.equal(sendOutcome.status, 'executed');

    // The draft WAS found (proving this isn't just "no draftId -> no-op") --
    // diffDraftAgainstSend() correctly found zero differing fields.
    const rows = db.prepare("SELECT * FROM feedback_events WHERE outcome = 'edited' AND subject_id = ?").all(sendOutcome.id);
    assert.equal(rows.length, 0);
  } finally {
    cleanupDirect(dir);
  }
});

test('KNOWN LIMITATION: a draft and a later send in a SEPARATE turn (different correlationId) is not detected as edited, even though the content differs', async () => {
  const dir = tempHome('u2os-feedback-limitation-');
  try {
    const { agent, db } = buildAgent();
    const actor = { type: 'user', id: 'user' };

    // Turn 1: draft (its own correlationId, exactly like a real
    // handleMessage() call would mint).
    await agent.evaluateAndMaybeExecute({
      tool: 'email.draft',
      arguments: { to: 'sarah@example.com', subject: 'Original subject', body: 'Original body' },
      requestedBy: 'user',
      correlationId: 'corr_turn_1',
      actor,
    });

    // Turn 2: send, with edited content, but a DIFFERENT correlationId --
    // this is the realistic "drafted, edited via UI, sent later" workflow.
    // Per email-edit-detector.js's documented limitation, this cannot be
    // linked back to the draft and so is NOT recorded as 'edited'.
    const sendProposal = await agent.evaluateAndMaybeExecute({
      tool: 'email.send',
      arguments: { to: 'sarah@example.com', subject: 'Edited later subject', body: 'Edited later body' },
      requestedBy: 'user',
      correlationId: 'corr_turn_2',
      actor,
    });
    const sendOutcome = await agent.approveAction(sendProposal.id, 'user');
    assert.equal(sendOutcome.status, 'executed');

    const rows = db.prepare("SELECT * FROM feedback_events WHERE outcome = 'edited' AND subject_id = ?").all(sendOutcome.id);
    assert.equal(rows.length, 0, 'cross-turn edits are a documented gap, not a false negative bug');
  } finally {
    cleanupDirect(dir);
  }
});

test('REGRESSION (security review): two drafts sharing one correlationId -- sending one unmodified is never misattributed to the other draft', async () => {
  // A previous version of email-edit-detector.js matched a send to "the
  // most recent draft sharing this correlationId," with no check that it
  // was the SAME draft the send actually came from. Two drafts in one turn
  // (e.g. drafting to two different people) broke that assumption: sending
  // the FIRST draft unmodified could be misattributed to the SECOND
  // (different) draft and wrongly flagged as 'edited'. Fixed by requiring
  // an explicit draftId; this proves the fix holds for exactly that shape.
  const dir = tempHome('u2os-feedback-multidraft-');
  try {
    const { agent, db } = buildAgent();
    const correlationId = 'corr_two_drafts_one_turn';
    const actor = { type: 'user', id: 'user' };

    const draftAlice = await agent.evaluateAndMaybeExecute({
      tool: 'email.draft',
      arguments: { to: 'alice@example.com', subject: 'To Alice', body: 'Alice body' },
      requestedBy: 'user',
      correlationId,
      actor,
    });
    const draftBob = await agent.evaluateAndMaybeExecute({
      tool: 'email.draft',
      arguments: { to: 'bob@example.com', subject: 'To Bob', body: 'Bob body' },
      requestedBy: 'user',
      correlationId,
      actor,
    });
    assert.notEqual(draftAlice.result.id, draftBob.result.id);

    // Send Alice's email, byte-identical to her own draft, correctly
    // naming HER draftId (not Bob's, and not omitted).
    const sendProposal = await agent.evaluateAndMaybeExecute({
      tool: 'email.send',
      arguments: { to: 'alice@example.com', subject: 'To Alice', body: 'Alice body', draftId: draftAlice.result.id },
      requestedBy: 'user',
      correlationId,
      actor,
    });
    const sendOutcome = await agent.approveAction(sendProposal.id, 'user');
    assert.equal(sendOutcome.status, 'executed');

    const rows = db.prepare("SELECT * FROM feedback_events WHERE outcome = 'edited' AND subject_id = ?").all(sendOutcome.id);
    assert.equal(
      rows.length,
      0,
      "Alice's unmodified send must not be flagged as edited just because Bob's draft also shares the correlationId"
    );
  } finally {
    cleanupDirect(dir);
  }
});

test('REGRESSION (security review): sending an email that was never drafted at all is never flagged as edited', async () => {
  const dir = tempHome('u2os-feedback-nodraft-');
  try {
    const { agent, db } = buildAgent();
    const actor = { type: 'user', id: 'user' };

    // No email.draft call at all -- a send with no draftId.
    const sendProposal = await agent.evaluateAndMaybeExecute({
      tool: 'email.send',
      arguments: { to: 'zoe@example.com', subject: 'Never drafted', body: 'Completely fresh email' },
      requestedBy: 'user',
      correlationId: 'corr_no_draft',
      actor,
    });
    const sendOutcome = await agent.approveAction(sendProposal.id, 'user');
    assert.equal(sendOutcome.status, 'executed');

    const rows = db.prepare("SELECT * FROM feedback_events WHERE outcome = 'edited' AND subject_id = ?").all(sendOutcome.id);
    assert.equal(rows.length, 0);
  } finally {
    cleanupDirect(dir);
  }
});

// --- scoreForSuggestion() ---------------------------------------------------

test('scoreForSuggestion: bounded output range and "more rejections -> more negative" direction', async () => {
  const dir = tempHome('u2os-prioritizer-');
  try {
    buildAgent(); // just to init the db/schema

    const none = scoreForSuggestion({ tool: 'notifications.send', domain: 'email' });
    assert.equal(none.adjustment, 0);
    assert.equal(none.sampleSize, 0);
    assert.deepEqual(none.influencedBy, []);

    for (let i = 0; i < 5; i++) {
      recordFeedback({
        subjectType: 'notification',
        subjectId: `notif_${i}`,
        outcome: 'rejected',
        detail: { tool: 'notifications.send', domain: 'email' },
      });
    }
    const mostlyNegative = scoreForSuggestion({ tool: 'notifications.send', domain: 'email' });
    assert.ok(mostlyNegative.adjustment < 0, 'more rejections must push the adjustment negative');
    assert.ok(mostlyNegative.adjustment >= -MAX_ADJUSTMENT && mostlyNegative.adjustment <= MAX_ADJUSTMENT);
    assert.equal(mostlyNegative.sampleSize, 5);
    assert.equal(mostlyNegative.influencedBy.length, 5);

    for (let i = 0; i < 20; i++) {
      recordFeedback({
        subjectType: 'notification',
        subjectId: `notif_pos_${i}`,
        outcome: 'accepted',
        detail: { tool: 'notifications.send', domain: 'email' },
      });
    }
    const mostlyPositive = scoreForSuggestion({ tool: 'notifications.send', domain: 'email' });
    assert.ok(mostlyPositive.adjustment > mostlyNegative.adjustment, 'more acceptances must push the adjustment upward');
    assert.ok(mostlyPositive.adjustment <= MAX_ADJUSTMENT);
  } finally {
    cleanupDirect(dir);
  }
});

test('email.received borderline notify/recommend/ignore decision is nudged by accumulated negative feedback', async () => {
  const dir = tempHome('u2os-borderline-');
  try {
    const { agent } = buildAgent();

    for (let i = 0; i < 10; i++) {
      recordFeedback({
        subjectType: 'notification',
        subjectId: `notif_recruiter_${i}`,
        outcome: 'dismissed',
        detail: { tool: 'notifications.send', domain: 'email' },
      });
    }

    const result = await agent.evaluateEvent({
      type: 'email.received',
      data: { from: 'jamie.alvarez@northwindtalent.example', subject: 'Following up' },
      subject: { type: 'email', id: 'em_borderline' },
    });

    // 10/10 dismissed -> raw = -1 -> adjustment = -MAX_ADJUSTMENT (<=-0.15) -> ignore.
    assert.equal(result.decision, 'ignore');
    assert.ok(result.feedbackAdjustment.adjustment < 0);
  } finally {
    cleanupDirect(dir);
  }
});

// --- CRITICAL: feedback never influences policy-engine.js's authorization -

test('CRITICAL: feedback that maximally favors "just do it" does not change policy-engine.js\'s resolution for a confirm/never tool', async () => {
  const dir = tempHome('u2os-critical-invariant-');
  try {
    buildAgent();

    // Accumulate feedback that would maximally favor autonomy if anything
    // read it for authorization purposes: every row 'accepted', for the
    // exact tool/domain about to be evaluated.
    for (let i = 0; i < 50; i++) {
      recordFeedback({
        subjectType: 'agent_action',
        subjectId: `act_${i}`,
        outcome: 'accepted',
        detail: { tool: 'email.send', domain: 'email' },
      });
    }
    const score = scoreForSuggestion({ tool: 'email.send', domain: 'email' });
    assert.equal(score.adjustment, MAX_ADJUSTMENT, 'sanity check: this really is the maximally-positive case');

    const policyEngine = new PolicyEngine();

    // A `never`-blocked email.send (legal category) must remain blocked --
    // completely unaffected by the accumulated feedback above, because
    // policy-engine.js takes no feedback input at all.
    const neverResult = policyEngine.evaluate({
      tool: { name: 'email.send', domain: 'email', category: 'consequential' },
      arguments: { to: 'lawyer@example.com' },
      context: { category: 'legal' },
    });
    assert.equal(neverResult.blocked, true);
    assert.equal(neverResult.requiresApproval, true);
    assert.equal(neverResult.autonomyLevel, 5);

    // A `confirm` calendar.reschedule must still require approval.
    for (let i = 0; i < 50; i++) {
      recordFeedback({
        subjectType: 'agent_action',
        subjectId: `act_cal_${i}`,
        outcome: 'accepted',
        detail: { tool: 'calendar.reschedule', domain: 'calendar' },
      });
    }
    const confirmResult = policyEngine.evaluate({
      tool: { name: 'calendar.reschedule', domain: 'calendar', category: 'consequential' },
      arguments: { eventId: 'evt_x' },
      context: { category: 'personal' },
    });
    assert.equal(confirmResult.requiresApproval, true);
    assert.equal(confirmResult.autonomyLevel, 3);
  } finally {
    cleanupDirect(dir);
  }
});

test('policies.yaml is byte-identical before and after a feedback-heavy scenario (approve/reject/POST feedback/scoreForSuggestion)', async () => {
  const dir = tempHome('u2os-policies-untouched-');
  let handle;
  try {
    ensureInstallationMode('demo', dir);
    const file = policiesPath(dir);
    ensureDefaultPolicies(dir);
    const before = fs.readFileSync(file);
    const statBefore = fs.statSync(file);

    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const agentRes = await postJson(port, '/api/agent/message', {
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
    });
    const proposed = agentRes.json.actions[0];
    await postJson(port, `/api/actions/${proposed.id}/approve`, { approvedBy: 'user' });

    const agentRes2 = await postJson(port, '/api/agent/message', {
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
    });
    if (agentRes2.json.actions[0]) {
      await postJson(port, `/api/actions/${agentRes2.json.actions[0].id}/reject`, { rejectedBy: 'user' });
    }

    await postJson(port, '/api/feedback', { subjectType: 'dashboard_card', subjectId: 'card_x', outcome: 'dismissed' });
    await postJson(port, '/api/feedback', { subjectType: 'notification', subjectId: 'notif_x', outcome: 'marked_useful' });

    for (let i = 0; i < 10; i++) {
      recordFeedback({ subjectType: 'notification', subjectId: `n_${i}`, outcome: 'rejected', detail: { tool: 'notifications.send', domain: 'email' } });
    }
    scoreForSuggestion({ tool: 'notifications.send', domain: 'email' });

    const after = fs.readFileSync(file);
    const statAfter = fs.statSync(file);
    assert.deepEqual(after, before, 'policies.yaml content must be byte-identical');
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, 'policies.yaml must never be re-written by any Phase 7 code path');
  } finally {
    await cleanupServer(dir, handle);
  }
});
