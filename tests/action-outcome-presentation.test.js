import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOutcomeSentence, approvalOutcomeLabel, approvalOutcomeGuidance, UNCERTAIN_GUIDANCE } from '../public/components/action-outcome.js';

test('action presentation distinguishes pending, stopped, rejected and unconfirmed states without claiming delivery', () => {
  for (const status of ['approved', 'queued', 'leased', 'executing', 'retry_wait']) {
    assert.equal(actionOutcomeSentence({ status, tool: 'email.send' }), 'Approved; delivery is still pending.');
    assert.equal(approvalOutcomeLabel({ status }), 'Approved; delivery pending'); assert.equal(approvalOutcomeGuidance({ status }), '');
  }
  for (const status of ['failed', 'blocked', 'dead_letter']) {
    assert.equal(actionOutcomeSentence({ status, tool: 'email.send' }), 'Action stopped. Check Operations for the reason.');
    assert.equal(approvalOutcomeLabel({ status }), 'Action stopped'); assert.match(approvalOutcomeGuidance({ status }), /Check Operations/);
  }
  for (const status of ['rejected', 'cancelled']) assert.equal(actionOutcomeSentence({ status }), 'Cancelled.');
  assert.equal(actionOutcomeSentence({ status: 'pending' }), 'Awaiting approval.');
  assert.equal(actionOutcomeSentence({ status: 'unexpected' }), 'Action status is not confirmed. Check Operations.');
});
test('explicit uncertain outcomes override contradictory status without sent/done/no-effect claims', () => {
  for (const status of ['failed', 'pending', 'executed', 'queued']) {
    const action = { status, tool: 'email.send', errorClass: 'outcome_uncertain' };
    assert.equal(actionOutcomeSentence(action), UNCERTAIN_GUIDANCE); assert.equal(approvalOutcomeGuidance(action), UNCERTAIN_GUIDANCE);
    assert.equal(approvalOutcomeLabel(action), 'Outcome uncertain'); assert.doesNotMatch(actionOutcomeSentence(action), /Sent\.|Done\.|didn't go through/);
  }
});
test('only confirmed executed actions retain their existing scoped completion sentences', () => {
  for (const [tool, sentence] of [['calendar.reschedule', 'Done. Rescheduled.'], ['calendar.create', 'Done. Added to your calendar.'],
    ['calendar.cancel', 'Done. Cancelled the event.'], ['email.send', 'Done. Sent.'], ['tasks.create', 'Done. Added the task.'],
    ['tasks.complete', 'Done. Marked complete.'], ['notifications.send', 'Done. Sent the notification.']]) {
    assert.equal(actionOutcomeSentence({ status: 'executed', tool }), sentence); assert.equal(approvalOutcomeLabel({ status: 'executed', tool }), 'Approved and done');
  }
  assert.equal(actionOutcomeSentence({ status: 'executed', tool: 'constructor' }), 'Action completed.');
});
test('provider error/results cannot supply guidance or completion authority', () => {
  const action = { status: 'failed', tool: 'email.send', errorClass: 'fixture-private-class', error: 'fixture-private-error', result: { status: 'executed', body: 'fixture-private-body' } };
  assert.doesNotMatch([actionOutcomeSentence(action), approvalOutcomeLabel(action), approvalOutcomeGuidance(action)].join(' '), /fixture-private|Done|Sent/);
  assert.equal(actionOutcomeSentence({ ...action, errorClass: 'outcome_uncertain' }), UNCERTAIN_GUIDANCE);
});
