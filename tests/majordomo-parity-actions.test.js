import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import {
  actionIdempotencyKey,
  beginActionAttempt,
  cancelUnstartedAction,
  completeActionAttempt,
  enqueueAction,
  failActionAttempt,
  getQueuedActionByActionId,
  leaseActionByActionId,
  listActionAttempts,
  requeueAction,
  retryDelayMs,
  stopLeasedAction,
} from '../server/agent/action-queue-store.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';

// Shared fixture for the Rust action state machine (majordomo/, ADR 0011,
// Phase 4a). This test drives Node's real queue store with the same fixture the
// Rust test (majordomo/tests/actions_parity.rs) reads and asserts the `node`
// column. Rows where Node and Rust differ carry a mandatory note.

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'majordomo', 'tests', 'fixtures', 'actions-parity.json'), 'utf8'));
const T0 = Date.parse('2026-09-20T12:00:00.000Z');
const iso = (offset) => new Date(T0 + offset).toISOString();

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-parity-actions-'));
  process.env.U2OS_HOME = dir;
  try { return fn(); } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function newAction() {
  return recordAudit({ requestedBy: 'user', tool: 'email.send', arguments: { to: 'a@example.test' }, status: 'approved', correlationId: 'corr_p', policyDomain: 'email', policyRule: 'r' });
}

const attempt = (queueId) => listActionAttempts(queueId).at(-1);

function setup(from, actionId) {
  const q = enqueueAction({ actionId, tool: 'email.send', now: iso(0) });
  const lease = () => leaseActionByActionId(actionId, { leaseOwner: 'w1', leaseMs: 30_000, now: iso(1000) });
  const run = (errorClass, maxAttempts = 5) => failActionAttempt(attempt(q.id).id, { leaseOwner: 'w1', error: 'e', errorClass, maxAttempts, now: iso(2000) });
  if (from === 'queued') return q;
  lease();
  if (from === 'leased') return q;
  if (from === 'cancelled') { stopLeasedAction(q.id, { leaseOwner: 'w1', status: 'cancelled', now: iso(1500) }); return q; }
  beginActionAttempt({ queueId: q.id, leaseOwner: 'w1', now: iso(1500) });
  if (from === 'executing') return q;
  if (from === 'completed') completeActionAttempt(attempt(q.id).id, { leaseOwner: 'w1', now: iso(2000) });
  else if (from === 'failed') run('non_retryable');
  else if (from === 'dead_letter') run('retryable', 1);
  else if (from === 'retry_wait') run('retryable');
  else throw new Error(`no Node setup for ${from}`);
  return q;
}

function apply(trigger, q, actionId) {
  const att = () => attempt(q.id)?.id ?? 'att_missing';
  const settle = (fn) => { try { fn(); return 'ok'; } catch { return 'reject'; } };
  const ops = {
    lease: () => (leaseActionByActionId(actionId, { leaseOwner: 'w2', leaseMs: 30_000, now: iso(10_000) }) ? 'ok' : 'reject'),
    expire_lease: () => (leaseActionByActionId(actionId, { leaseOwner: 'w2', leaseMs: 30_000, now: iso(60_000) }) ? 'ok' : 'reject'),
    begin_attempt: () => settle(() => beginActionAttempt({ queueId: q.id, leaseOwner: 'w1', now: iso(2000) })),
    complete: () => settle(() => completeActionAttempt(att(), { leaseOwner: 'w1', now: iso(2000) })),
    fail_retry: () => settle(() => failActionAttempt(att(), { leaseOwner: 'w1', error: 'e', errorClass: 'retryable', maxAttempts: 5, now: iso(2000) })),
    fail_dead_letter: () => settle(() => failActionAttempt(att(), { leaseOwner: 'w1', error: 'e', errorClass: 'retryable', maxAttempts: 1, now: iso(2000) })),
    fail_terminal: () => settle(() => failActionAttempt(att(), { leaseOwner: 'w1', error: 'e', errorClass: 'non_retryable', now: iso(2000) })),
    mark_uncertain: () => settle(() => failActionAttempt(att(), { leaseOwner: 'w1', error: 'e', errorClass: 'outcome_uncertain', now: iso(2000) })),
    stop_failed: () => settle(() => stopLeasedAction(q.id, { leaseOwner: 'w1', status: 'failed', now: iso(2000) })),
    stop_cancelled: () => settle(() => stopLeasedAction(q.id, { leaseOwner: 'w1', status: 'cancelled', now: iso(2000) })),
    stop_dead_letter: () => settle(() => stopLeasedAction(q.id, { leaseOwner: 'w1', status: 'dead_letter', now: iso(2000) })),
    cancel: () => (cancelUnstartedAction(actionId) ? 'ok' : 'reject'),
    requeue: () => settle(() => requeueAction(q.id, { now: iso(5000) })),
  };
  assert.ok(ops[trigger], `Node driver has no operation for ${trigger}`);
  return ops[trigger]();
}

function observe(from, trigger) {
  const action = newAction();
  const q = setup(from, action.id);
  assert.equal(getQueuedActionByActionId(action.id).status, from, `setup reached ${from}`);
  const result = apply(trigger, q, action.id);
  const after = getQueuedActionByActionId(action.id).status;
  return result === 'reject' ? { outcome: 'reject', after } : { outcome: after, after };
}

test('fixture rows that differ between Node and Rust carry a note', () => {
  for (const row of [...FIXTURE.transitions, ...FIXTURE.failure_outcomes]) {
    if (row.node !== 'n/a' && row.node !== row.rust) assert.ok(row.note, `difference without a note: ${JSON.stringify(row)}`);
  }
});

test('transition table: Node queue behaviour matches the fixture node column', () => withTempHome(() => {
  let checked = 0;
  for (const row of [...FIXTURE.transitions, ...FIXTURE.rejections]) {
    if (row.node === 'n/a') continue;
    const seen = observe(row.from, row.trigger);
    assert.equal(seen.outcome, row.node, `${row.from} + ${row.trigger}`);
    if (row.node === 'reject') assert.equal(seen.after, row.from, `a rejected ${row.trigger} must not change ${row.from}`);
    checked += 1;
  }
  assert.ok(checked > 30);
}));

test('error classification matches the fixture', () => {
  for (const { error, class: expected } of FIXTURE.classification) {
    assert.equal(classifyActionError(error), expected, JSON.stringify(error));
  }
});

test('retry delays match the fixture', () => {
  for (const c of FIXTURE.retry_delays) {
    assert.equal(retryDelayMs(c.attempt, { baseDelayMs: c.base, maxDelayMs: c.max }), c.ms);
  }
});

test('failure outcomes match the fixture node column', () => withTempHome(() => {
  for (const c of FIXTURE.failure_outcomes) {
    const action = newAction();
    const q = enqueueAction({ actionId: action.id, tool: 'email.send', now: iso(0) });
    // Reach attempt number c.attempt by failing earlier attempts as retryable.
    for (let n = 1; n <= c.attempt; n += 1) {
      leaseActionByActionId(action.id, { leaseOwner: 'w1', leaseMs: 1000, now: iso(n * 1_000_000) });
      const a = beginActionAttempt({ queueId: q.id, leaseOwner: 'w1', now: iso(n * 1_000_000) });
      const last = n === c.attempt;
      const done = failActionAttempt(a.id, { leaseOwner: 'w1', error: 'e', errorClass: last ? c.class : 'retryable', maxAttempts: last ? c.max : 100, now: iso(n * 1_000_000) });
      if (last) assert.equal(done.status, c.node, JSON.stringify(c));
    }
  }
}));

test('idempotency keys match the fixture and require tool and action id', () => {
  for (const k of FIXTURE.idempotency_keys) {
    assert.equal(actionIdempotencyKey({ tool: k.tool, correlationId: k.correlationId, actionId: k.actionId }), k.key);
  }
  assert.throws(() => actionIdempotencyKey({ tool: '', actionId: 'a' }), TypeError);
  assert.throws(() => actionIdempotencyKey({ tool: 't', actionId: '' }), TypeError);
});

test('scenarios: Node queue behaviour matches the fixture', () => withTempHome(() => {
  for (const scenario of FIXTURE.scenarios) {
    const action = newAction();
    let q = null;
    scenario.steps.forEach((step, i) => {
      const label = `${scenario.name} step ${i} (${step.op})`;
      const att = () => attempt(q.id)?.id ?? 'att_missing';
      let ok = true;
      if (step.op === 'enqueue') {
        q = enqueueAction({ actionId: action.id, tool: 'email.send', now: iso(step.at) });
      } else if (step.op === 'lease') {
        ok = leaseActionByActionId(action.id, { leaseOwner: step.owner, leaseMs: step.leaseMs, now: iso(step.at) }) !== null;
      } else {
        try {
          if (step.op === 'begin') beginActionAttempt({ queueId: q.id, leaseOwner: step.owner, now: iso(step.at) });
          else if (step.op === 'complete') completeActionAttempt(att(), { leaseOwner: step.owner, now: iso(step.at) });
          else if (step.op === 'fail') failActionAttempt(att(), { leaseOwner: step.owner, error: 'e', errorClass: step.errorClass, maxAttempts: step.maxAttempts, now: iso(step.at) });
          else throw new Error(`unknown op ${step.op}`);
        } catch (e) {
          if (e.message?.startsWith('unknown op')) throw e;
          ok = false;
        }
      }
      const row = getQueuedActionByActionId(action.id);
      const expect = step.expect_node ?? step.expect;
      if ('ok' in expect) assert.equal(ok, expect.ok, `${label}: ok`);
      if ('status' in expect) assert.equal(row.status, expect.status, `${label}: status`);
      if ('owner' in expect) assert.equal(row.lease_owner, expect.owner, `${label}: owner`);
      if ('next_attempt_at' in expect) assert.equal(Date.parse(row.next_attempt_at) - T0, expect.next_attempt_at, `${label}: next_attempt_at`);
      if (step.expect_node || step.expect_rust) assert.ok(step.note, `${label}: difference needs a note`);
    });
  }
}));
