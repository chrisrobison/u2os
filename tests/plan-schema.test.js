// Strict plan schema tests (PLAN.md Phase 3). validatePlan() is the one
// gate between raw model output and the policy engine -- every case here
// is a shape a real or adversarial model could plausibly produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validatePlanWithRepair } from '../server/agent/plan-validator.js';
import { createToolRegistry } from '../server/tools/register-all.js';

const registry = createToolRegistry();

test('a well-formed plan with reason and dependsOn on its actions validates and round-trips those fields', () => {
  const plan = validatePlan(
    {
      reasoning_summary: 'Create two tasks',
      actions: [
        { tool: 'tasks.create', arguments: { title: 'First' }, reason: 'Kick off the sequence' },
        { tool: 'tasks.create', arguments: { title: 'Second' }, reason: 'Follows the first', dependsOn: [0] },
      ],
    },
    registry
  );
  assert.equal(plan.actions[1].dependsOn[0], 0);
  assert.equal(plan.actions[0].reason, 'Kick off the sequence');
});

test('rejects an unrecognized top-level plan field (never silently trusted)', () => {
  assert.throws(
    () => validatePlan({ reasoning_summary: '', actions: [], executeShellCommand: 'rm -rf /' }, registry),
    /unrecognized field "executeShellCommand"/
  );
});

test('rejects an unrecognized action field', () => {
  assert.throws(
    () => validatePlan({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: { title: 'x' }, priority: 'urgent' }] }, registry),
    /unrecognized field "priority"/
  );
});

test('rejects a dependsOn that references a later or equal action index (no forward refs, no self-refs, no cycles)', () => {
  assert.throws(
    () =>
      validatePlan(
        { reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: { title: 'x' }, dependsOn: [0] }] },
        registry
      ),
    /invalid reference/
  );
  assert.throws(
    () =>
      validatePlan(
        {
          reasoning_summary: '',
          actions: [
            { tool: 'tasks.create', arguments: { title: 'a' } },
            { tool: 'tasks.create', arguments: { title: 'b' }, dependsOn: [5] },
          ],
        },
        registry
      ),
    /invalid reference/
  );
});

test('rejects arguments nested deeper than the configured limit', () => {
  let deep = { title: 'x' };
  let cursor = deep;
  for (let i = 0; i < 10; i++) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: deep }] }, registry), /maximum nesting depth/);
});

test('rejects a reason field that is not a string', () => {
  assert.throws(
    () => validatePlan({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: { title: 'x' }, reason: 42 }] }, registry),
    /reason must be a string/
  );
});

test('validates memoryCandidates: requires non-empty content and a recognized confidence level, bounded in count', () => {
  const plan = validatePlan(
    { reasoning_summary: '', actions: [], memoryCandidates: [{ content: 'Sarah prefers morning meetings', confidence: 'medium' }] },
    registry
  );
  assert.equal(plan.memoryCandidates[0].content, 'Sarah prefers morning meetings');

  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [], memoryCandidates: [{ content: '' }] }, registry), /non-empty string content/);
  assert.throws(
    () => validatePlan({ reasoning_summary: '', actions: [], memoryCandidates: [{ content: 'x', confidence: 'certain' }] }, registry),
    /confidence must be one of/
  );
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ content: `fact ${i}` }));
  assert.throws(() => validatePlan({ reasoning_summary: '', actions: [], memoryCandidates: tooMany }, registry), /memoryCandidates limit/);
});

test('validates an optional response string field', () => {
  const plan = validatePlan({ reasoning_summary: 's', actions: [], response: 'Here is your answer.' }, registry);
  assert.equal(plan.response, 'Here is your answer.');
  assert.throws(() => validatePlan({ reasoning_summary: 's', actions: [], response: 42 }, registry), /response must be a string/);
});

// --- validatePlanWithRepair: exactly one bounded, non-fabricating pass ---

test('repair pass strips an unrecognized top-level field instead of rejecting the whole plan', () => {
  const plan = validatePlanWithRepair({ reasoning_summary: 'ok', actions: [], notes: 'ignore me' }, registry);
  assert.equal(plan.reasoning_summary, 'ok');
});

test('repair pass wraps a single action object into a one-element array', () => {
  const plan = validatePlanWithRepair({ reasoning_summary: 'ok', actions: { tool: 'tasks.create', arguments: { title: 'x' } } }, registry);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].tool, 'tasks.create');
});

test('repair pass defaults a missing actions array to empty and a missing reasoning_summary to an empty string', () => {
  const plan = validatePlanWithRepair({}, registry);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.reasoning_summary, '');
});

test('repair pass NEVER fabricates a fix for an individual invalid action -- an invented tool still fails, with the ORIGINAL error', async () => {
  assert.throws(
    () => validatePlanWithRepair({ reasoning_summary: '', actions: [{ tool: 'shell.exec', arguments: {} }] }, registry),
    /Unknown tool/
  );
});

test('repair pass NEVER fabricates a fix for missing required arguments', () => {
  assert.throws(
    () => validatePlanWithRepair({ reasoning_summary: '', actions: [{ tool: 'tasks.create', arguments: {} }] }, registry),
    /missing required argument/
  );
});

test('attemptRepair: false disables the repair pass entirely, same as before', () => {
  assert.throws(() => validatePlanWithRepair({ actions: [] }, registry, { attemptRepair: false }), /requires reasoning_summary/);
});
