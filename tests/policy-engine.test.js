import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../server/policy/policy-engine.js';

function fakeTool({ name, domain, category }) {
  return { name, domain, category };
}

test('read tools are always allowed regardless of policy config', () => {
  const engine = new PolicyEngine({ policies: {} });
  const tool = fakeTool({ name: 'calendar.list', domain: 'calendar', category: 'read' });
  const result = engine.evaluate({ tool, arguments: {}, context: {} });
  assert.equal(result.autonomyLevel, 0);
  assert.equal(result.requiresApproval, false);
  assert.equal(result.blocked, false);
});

test('calendar.reschedule for a personal event requires confirmation per the shipped seed policy', () => {
  // Mirrors server/policy/policies-loader.js's default policy: no blanket
  // "personal: autonomous" rule, so a 'personal' category falls through to
  // `default: confirm` -- this is what makes the vertical slice genuinely
  // exercise the approval flow.
  const engine = new PolicyEngine({
    policies: { calendar: { reschedule: { interviews: 'confirm', default: 'confirm' } } },
  });
  const tool = fakeTool({ name: 'calendar.reschedule', domain: 'calendar', category: 'consequential' });
  const result = engine.evaluate({ tool, arguments: { eventId: 'x' }, context: { category: 'personal' } });
  assert.equal(result.requiresApproval, true);
  assert.equal(result.autonomyLevel, 3);
  assert.equal(result.blocked, false);
  assert.equal(result.rule, 'calendar.reschedule.default:confirm');
});

test('an "autonomous" string policy does not require approval', () => {
  const engine = new PolicyEngine({ policies: { calendar: { create: 'autonomous' } } });
  const tool = fakeTool({ name: 'calendar.create', domain: 'calendar', category: 'consequential' });
  const result = engine.evaluate({ tool, arguments: {}, context: {} });
  assert.equal(result.requiresApproval, false);
  assert.equal(result.autonomyLevel, 4);
});

test('"never" blocks the action, surfaced as blocked -- not a silently-approvable action', () => {
  const engine = new PolicyEngine({ policies: { email: { send: { legal: 'never' } } } });
  const tool = fakeTool({ name: 'email.send', domain: 'email', category: 'consequential' });
  const result = engine.evaluate({ tool, arguments: {}, context: { category: 'legal' } });
  assert.equal(result.blocked, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.autonomyLevel, 5);
});

test('missing domain/operation policy falls back to confirm, never to silent autonomy', () => {
  const engine = new PolicyEngine({ policies: {} });
  const tool = fakeTool({ name: 'tasks.create', domain: 'tasks', category: 'consequential' });
  const result = engine.evaluate({ tool, arguments: {}, context: {} });
  assert.equal(result.requiresApproval, true);
  assert.equal(result.autonomyLevel, 3);
  assert.equal(result.blocked, false);
});

test('missing sub-category within an object policy falls back to default, not autonomous', () => {
  const engine = new PolicyEngine({
    policies: { calendar: { reschedule: { interviews: 'confirm', default: 'confirm' } } },
  });
  const tool = fakeTool({ name: 'calendar.reschedule', domain: 'calendar', category: 'consequential' });
  // No context.category at all -- must not silently resolve to autonomous.
  const result = engine.evaluate({ tool, arguments: {}, context: {} });
  assert.equal(result.requiresApproval, true);
  assert.notEqual(result.autonomyLevel, 4);
});

test('a model-proposed arguments.category cannot escalate autonomy -- only server-derived context counts', () => {
  // Regression test: the policy engine must never let the action's own
  // proposed `arguments` categorize themselves. Only `context` -- which the
  // agent must derive from authoritative data -- is trusted. Otherwise a
  // model could tag arguments.category:'friends' on an email.send to a
  // legal contact and silently bypass a `never` block.
  const engine = new PolicyEngine({
    policies: { email: { send: { friends: 'autonomous', legal: 'never' } } },
  });
  const tool = fakeTool({ name: 'email.send', domain: 'email', category: 'consequential' });

  const withoutContext = engine.evaluate({
    tool,
    arguments: { to: 'lawyer@example.com', category: 'friends' },
    context: {},
  });
  assert.equal(withoutContext.requiresApproval, true);
  assert.notEqual(withoutContext.autonomyLevel, 4);
  assert.equal(withoutContext.rule, 'email.send:fallback-confirm');

  const withRealContext = engine.evaluate({
    tool,
    arguments: { to: 'lawyer@example.com', category: 'friends' },
    context: { category: 'legal' },
  });
  assert.equal(withRealContext.blocked, true);
});
