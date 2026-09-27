import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPackageFixture, packageManifest } from './helpers/package-fixture.js';
import { getAgentAction } from '../server/policy/policy-engine.js';
import { revokePermissions, listPackageAudit, setPackageEnabled } from '../server/packages/store.js';
import { validatePlan } from '../server/agent/plan-validator.js';
import { buildPlanRequestPayload } from '../server/agent/prompt-payload.js';

function demoPackage(fx, { grant = 'all', permissions = { network: true, notifications: { send: true } } } = {}) {
  return fx.install({
    manifest: packageManifest('com.example.demo', {
      requires: { capabilities: ['web.search'] },
      exports: { capabilities: [
        { id: 'demo.lookup', file: 'capabilities/lookup.yaml' },
        { id: 'demo.write', file: 'capabilities/write.yaml' },
        { id: 'demo.bad-output', file: 'capabilities/bad.yaml' },
        { id: 'mock.needs-confirm', file: 'capabilities/confirm.yaml' },
        { id: 'mock.always-denied', file: 'capabilities/never.yaml' },
      ] },
      permissions,
    }),
    capabilities: {
      'demo.lookup': { id: 'demo.lookup', effect: 'read', permissions: ['network'],
        inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1 } } },
        outputSchema: { type: 'object', required: ['results'] },
        implementation: { type: 'fixture', file: 'fixtures/data.json', output: { results: '{{ data.items }}', query: '{{ input.query }}' } } },
      'demo.write': { id: 'demo.write', effect: 'write', permissions: ['notifications.send'],
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        implementation: { type: 'static', output: { delivered: true, to: '{{ input.to }}', simulated: true } } },
      'demo.bad-output': { id: 'demo.bad-output', effect: 'read', outputSchema: { type: 'object', required: ['ok'] },
        implementation: { type: 'static', output: { nope: true } } },
      'mock.needs-confirm': { id: 'mock.needs-confirm', effect: 'write', implementation: { type: 'static', output: { done: true } } },
      'mock.always-denied': { id: 'mock.always-denied', effect: 'write', implementation: { type: 'static', output: { done: true } } },
    },
    files: { 'fixtures/data.json': { items: [{ title: 'Staff Engineer' }] } },
    grant,
  });
}

const ctx = (extra = {}) => ({ packageId: 'com.example.demo', automationId: 'demo', workflowRunId: 'wfr_test', stepId: 'step', ...extra });

test('a permitted package capability runs through the gate and is audited', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const outcome = await fx.invoker.invoke('demo.lookup', { query: 'staff' }, ctx());
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(outcome.output, { results: [{ title: 'Staff Engineer' }], query: 'staff' });
    const action = getAgentAction(outcome.actionId);
    assert.equal(action.status, 'executed');
    assert.equal(action.requested_by, 'package:com.example.demo');
    assert.equal(action.packageContext.automation, 'demo');
    assert.equal(action.packageContext.permission.allowed, true);
    assert.deepEqual(action.packageContext.permission.required, ['network']);
    const audit = listPackageAudit({ packageId: 'com.example.demo' });
    assert.equal(audit[0].action, 'demo.lookup');
  } finally { await fx.cleanup(); }
});

test('permission denial: an ungranted permission blocks and audits the action', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx, { grant: [] });
    const outcome = await fx.invoker.invoke('demo.lookup', { query: 'staff' }, ctx());
    assert.equal(outcome.status, 'denied');
    assert.match(outcome.reason, /not granted: network/);
    const action = getAgentAction(outcome.actionId);
    assert.equal(action.status, 'blocked');
    assert.equal(action.policy_rule, 'package-permission');
    assert.deepEqual(action.packageContext.permission.missingGrant, ['network']);
  } finally { await fx.cleanup(); }
});

test('permission denial: a core capability the package never declared is blocked', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const outcome = await fx.invoker.invoke('email.send', { to: 'a@example.com', subject: 's', body: 'b' }, ctx());
    assert.equal(outcome.status, 'denied');
    assert.match(outcome.reason, /not declared: email.send/);
  } finally { await fx.cleanup(); }
});

test('a disabled package cannot invoke anything', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    setPackageEnabled('com.example.demo', false);
    fx.registries.packages.get('com.example.demo').enabled = false;
    const outcome = await fx.invoker.invoke('demo.lookup', { query: 'staff' }, ctx());
    assert.equal(outcome.status, 'denied');
    assert.match(outcome.reason, /package is disabled/);
  } finally { await fx.cleanup(); }
});

test('policy denial and policy approval tighten the policies.yaml decision', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const denied = await fx.invoker.invoke('demo.write', { to: 'me' }, ctx({ policy: { name: 'notify', decision: 'deny', reasons: ['not met: job.score >= 85'] } }));
    assert.equal(denied.status, 'denied');
    assert.equal(getAgentAction(denied.actionId).policy_rule, 'package-policy:notify');
    assert.equal(getAgentAction(denied.actionId).packageContext.policy.decision, 'deny');

    const automatic = await fx.invoker.invoke('demo.write', { to: 'me' }, ctx({ policy: { name: 'notify', decision: 'automatic', reasons: [] } }));
    assert.equal(automatic.status, 'completed');
    assert.equal(automatic.output.delivered, true);

    const approval = await fx.invoker.invoke('demo.write', { to: 'me' }, ctx({ policy: { name: 'notify', decision: 'approval', reasons: [] } }));
    assert.equal(approval.status, 'waiting');
    assert.equal(getAgentAction(approval.actionId).status, 'pending');
    assert.equal(fx.invoker.actionOutcome('demo.write', approval.actionId).status, 'waiting');
    await fx.agent.approveAction(approval.actionId, 'owner');
    const resumed = fx.invoker.actionOutcome('demo.write', approval.actionId);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.output.to, 'me');
  } finally { await fx.cleanup(); }
});

test('a package policy can never loosen policies.yaml', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const automatic = { name: 'go', decision: 'automatic', reasons: [] };
    const confirm = await fx.invoker.invoke('mock.needs-confirm', {}, ctx({ policy: automatic }));
    assert.equal(confirm.status, 'waiting');
    const never = await fx.invoker.invoke('mock.always-denied', {}, ctx({ policy: automatic }));
    assert.equal(never.status, 'denied');
    assert.match(getAgentAction(never.actionId).policy_rule, /always-denied:never/);
  } finally { await fx.cleanup(); }
});

test('the queue worker re-checks package authority at execution time', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const pending = await fx.invoker.invoke('demo.write', { to: 'me' }, ctx({ policy: { name: 'notify', decision: 'approval', reasons: [] } }));
    revokePermissions('com.example.demo', ['notifications.send']);
    await fx.agent.approveAction(pending.actionId, 'owner');
    const outcome = fx.invoker.actionOutcome('demo.write', pending.actionId);
    assert.equal(outcome.status, 'denied');
    assert.match(outcome.reason, /no longer holds notifications.send/);
  } finally { await fx.cleanup(); }
});

test('without a package runtime attached, queued package actions fail closed', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const pending = await fx.invoker.invoke('demo.write', { to: 'me' }, ctx({ policy: { name: 'notify', decision: 'approval', reasons: [] } }));
    fx.agent.setPackageAuthority(null);
    await fx.agent.approveAction(pending.actionId, 'owner');
    assert.equal(getAgentAction(pending.actionId).status, 'blocked');
    assert.match(getAgentAction(pending.actionId).result.error, /Package runtime is not available/);
  } finally { await fx.cleanup(); }
});

test('inputs and outputs are validated against the capability schemas', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const bad = await fx.invoker.invoke('demo.lookup', { query: '' }, ctx());
    assert.equal(bad.status, 'failed');
    assert.equal(bad.code, 'invalid_input');
    assert.equal(bad.actionId, undefined);
    const badOutput = await fx.invoker.invoke('demo.bad-output', {}, ctx());
    assert.equal(badOutput.status, 'failed');
    assert.equal(badOutput.code, 'invalid_output');
    const unknown = await fx.invoker.invoke('nope.nothing', {}, ctx());
    assert.equal(unknown.code, 'unknown_capability');
  } finally { await fx.cleanup(); }
});

test('core capabilities run through their existing tools', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    const outcome = await fx.invoker.invoke('web.search', { query: 'u2os' }, ctx());
    assert.equal(outcome.status, 'completed');
    assert.ok(Array.isArray(outcome.output.results));
    assert.equal(getAgentAction(outcome.actionId).packageContext.provider, 'core');
  } finally { await fx.cleanup(); }
});

test('the planner never sees package capabilities and cannot propose them', async () => {
  const fx = createPackageFixture();
  try {
    demoPackage(fx);
    assert.ok(fx.toolRegistry.has('demo.write'));
    assert.ok(!fx.toolRegistry.list().some((tool) => tool.name.startsWith('demo.')));
    const payload = buildPlanRequestPayload({ toolRegistry: fx.toolRegistry, personalContext: {} }, 'x');
    assert.ok(!JSON.stringify(payload).includes('demo.write'));
    assert.throws(() => validatePlan({ reasoning_summary: 'x', actions: [{ tool: 'demo.write', arguments: { to: 'x' } }] }, fx.toolRegistry), /Unknown tool: demo.write/);
  } finally { await fx.cleanup(); }
});

test('module implementations require the code.execute grant', async () => {
  const fx = createPackageFixture();
  try {
    fx.install({
      manifest: packageManifest('com.example.code', {
        exports: { capabilities: [{ id: 'code.double', file: 'c.yaml' }] },
        permissions: { code: { execute: true } },
      }),
      capabilities: { 'code.double': { id: 'code.double', effect: 'read', permissions: ['code.execute'],
        implementation: { type: 'module', module: 'src/double.js', export: 'double' } } },
      files: { 'src/double.js': 'export async function double(input, ctx) { return { value: input.n * 2, pkg: ctx.packageId }; }' },
      grant: [],
    });
    const denied = await fx.invoker.invoke('code.double', { n: 2 }, { packageId: 'com.example.code' });
    assert.equal(denied.status, 'denied');
    const { grantPermissions } = await import('../server/packages/store.js');
    grantPermissions('com.example.code', ['code.execute']);
    const allowed = await fx.invoker.invoke('code.double', { n: 2 }, { packageId: 'com.example.code' });
    assert.equal(allowed.status, 'completed');
    assert.deepEqual(allowed.output, { value: 4, pkg: 'com.example.code' });
  } finally { await fx.cleanup(); }
});
