import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvaluatorRegistry } from '../server/agent/proactive/evaluator-registry.js';
import { registerBuiltinEvaluators, evaluateEmailReceived } from '../server/agent/proactive/builtin-evaluators.js';

test('register() requires a string eventPattern and an evaluate function', () => {
  const registry = new EvaluatorRegistry();
  assert.throws(() => registry.register({ evaluate: () => {} }), /eventPattern/);
  assert.throws(() => registry.register({ eventPattern: 'x.y' }), /evaluate/);
});

test('find() resolves an exact event-type match', () => {
  const registry = new EvaluatorRegistry();
  const evaluate = async () => ({ decision: 'ignore' });
  registry.register({ eventPattern: 'task.overdue', evaluate });
  assert.equal(registry.find('task.overdue').evaluate, evaluate);
  assert.equal(registry.find('task.created'), null);
});

test('find() resolves a "<prefix>.*" wildcard pattern', () => {
  const registry = new EvaluatorRegistry();
  const evaluate = async () => ({ decision: 'ignore' });
  registry.register({ eventPattern: 'calendar.*', evaluate });
  assert.equal(registry.find('calendar.event_approaching').evaluate, evaluate);
  assert.equal(registry.find('calendar.event_changed').evaluate, evaluate);
  assert.equal(registry.find('task.overdue'), null);
});

test('find() resolves the "*" catch-all pattern', () => {
  const registry = new EvaluatorRegistry();
  const evaluate = async () => ({ decision: 'ignore' });
  registry.register({ eventPattern: '*', evaluate });
  assert.equal(registry.find('anything.at.all').evaluate, evaluate);
});

test('first registered match wins when multiple patterns could match', () => {
  const registry = new EvaluatorRegistry();
  const specific = async () => ({ decision: 'notify' });
  const fallback = async () => ({ decision: 'ignore' });
  registry.register({ eventPattern: 'email.received', evaluate: specific });
  registry.register({ eventPattern: '*', evaluate: fallback });
  assert.equal(registry.find('email.received').evaluate, specific);
  assert.equal(registry.find('email.bounced').evaluate, fallback);
});

test('a skill can register a new evaluator without editing Agent, and it is discoverable via list()', () => {
  const registry = registerBuiltinEvaluators(new EvaluatorRegistry());
  const before = registry.list().length;
  registry.register({ eventPattern: 'project.changed', evaluate: async () => ({ decision: 'remember' }), name: 'skill:project-tracker' });
  assert.equal(registry.list().length, before + 1);
  assert.equal(registry.find('project.changed').name, 'skill:project-tracker');
  // Existing builtins are untouched.
  assert.ok(registry.find('email.received'));
});

test('evaluateEmailReceived ignores non-recruiter senders without calling proposeAction', async () => {
  let called = false;
  const result = await evaluateEmailReceived(
    { type: 'email.received', data: { from: 'newsletter@example.com', subject: 'Weekly digest' } },
    { correlationId: 'c1', actor: { type: 'agent', id: 'a' }, eventBus: { publish: () => {} }, proposeAction: async () => { called = true; } }
  );
  assert.equal(result.decision, 'ignore');
  assert.equal(called, false);
});
