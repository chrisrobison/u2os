import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPackageFixture, packageManifest } from './helpers/package-fixture.js';
import { WorkflowEngine } from '../server/packages/workflow-engine.js';
import { ensureAutomationInstance, getRun, listSteps, getInstanceByAutomation, recoverInterruptedRuns } from '../server/packages/workflow-store.js';
import { getAgentAction } from '../server/policy/policy-engine.js';
import { getDb } from '../server/db/connection.js';

const JOBS = { jobs: [
  { title: 'Staff Engineer', company: 'Acme', salary: 190000, remote: true },
  { title: 'Junior Dev', company: 'Beta', salary: 90000, remote: false },
  { title: 'Principal Engineer', company: 'Gamma', salary: 230000, remote: true },
] };

function installJobs(fx, { automation, extraCapabilities = {}, extraExports = [], files = {}, permissions = { network: true, notifications: { send: true }, code: { execute: true } } } = {}) {
  return fx.install({
    manifest: packageManifest('com.example.jobs', {
      exports: {
        capabilities: [
          { id: 'mock.job-search', file: 'capabilities/search.yaml' },
          { id: 'mock.email-send', file: 'capabilities/send.yaml' },
          ...extraExports,
        ],
        skills: [
          { id: 'normalize-job', file: 'skills/normalize.yaml' },
          { id: 'score-job', file: 'skills/score.yaml' },
          { id: 'company-research', file: 'skills/research.yaml' },
          { id: 'evaluate-job', file: 'skills/evaluate.yaml' },
        ],
        automations: automation ? [{ id: 'job-hunter', file: 'automations/job-hunter.yaml' }] : [],
      },
      permissions,
      policies: {
        notifyCandidate: { all: ['input.score >= settings.notifyThreshold'], approval: 'automatic' },
        askFirst: { approval: 'required' },
      },
      settings: { notifyThreshold: { type: 'number', default: 80 }, minimumSalary: { type: 'number', default: 150000 } },
      events: { emits: ['job.candidate'] },
    }),
    capabilities: {
      'mock.job-search': { id: 'mock.job-search', effect: 'read', permissions: ['network'],
        implementation: { type: 'fixture', file: 'fixtures/jobs.json' } },
      'mock.email-send': { id: 'mock.email-send', effect: 'write', permissions: ['notifications.send'],
        inputSchema: { type: 'object', required: ['to', 'subject'], properties: { to: { type: 'string' }, subject: { type: 'string' }, score: { type: 'number' } } },
        implementation: { type: 'static', output: { simulated: true, to: '{{ input.to }}', subject: '{{ input.subject }}' } } },
      ...extraCapabilities,
    },
    skills: {
      'normalize-job': { id: 'normalize-job', inputSchema: { type: 'object', required: ['job'] },
        steps: [{ id: 'shape', use: 'transform', with: { value: { title: '{{ inputs.job.title }}', company: '{{ inputs.job.company }}', salary: '{{ inputs.job.salary }}', remote: '{{ inputs.job.remote }}' } } }] },
      'score-job': { id: 'score-job', outputSchema: { type: 'object', required: ['score'] },
        steps: [{ id: 'score', use: 'transform', with: { value: {
          title: '{{ inputs.job.title }}', company: '{{ inputs.job.company }}',
          score: '{{ (inputs.job.salary >= settings.minimumSalary ? 60 : 20) + (inputs.job.remote ? 30 : 0) }}' } } }],
        output: '{{ steps.score.output }}' },
      'company-research': { id: 'company-research', requires: { capabilities: ['mock.job-search'] },
        steps: [
          { id: 'lookup', use: 'capability:mock.job-search', with: { query: '{{ inputs.company }}' } },
          { id: 'summary', use: 'filter', with: { source: '{{ steps.lookup.output.jobs }}', where: 'item.company == inputs.company' } },
        ],
        output: { company: '{{ inputs.company }}', openRoles: '{{ len(steps.summary.output) }}' } },
      'evaluate-job': { id: 'evaluate-job',
        steps: [
          { id: 'normal', use: 'skill:normalize-job', with: { job: '{{ inputs.job }}' } },
          { id: 'scored', use: 'skill:score-job', with: { job: '{{ steps.normal.output }}' } },
        ] },
    },
    automations: automation ? { 'job-hunter': { id: 'job-hunter', ...automation } } : {},
    files: { 'fixtures/jobs.json': JOBS, ...files },
  });
}

function engineFor(fx, extra = {}) {
  return new WorkflowEngine({ registries: fx.registries, invoker: fx.invoker, eventBus: fx.eventBus, leaseMs: 5_000, ...extra });
}

function startAutomation(fx, engine, automation) {
  const definition = fx.registries.automations.get('job-hunter');
  ensureAutomationInstance({ packageId: definition.packageId, automationId: 'job-hunter', initialState: definition.state.initial });
  return engine.createAutomationRun({ automationId: 'job-hunter', ...automation }).run;
}

test('skills compose from capabilities and other skills', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx);
    const engine = engineFor(fx);
    const evaluated = await engine.runSkill('evaluate-job', { job: JOBS.jobs[0] });
    assert.equal(evaluated.status, 'completed', evaluated.error);
    assert.deepEqual(evaluated.outputs, { title: 'Staff Engineer', company: 'Acme', score: 90 });
    const research = await engine.runSkill('company-research', { company: 'Gamma' });
    assert.deepEqual(research.outputs, { company: 'Gamma', openRoles: 1 });
    const badInput = await engine.runSkill('normalize-job', {});
    assert.equal(badInput.status, 'failed');
    assert.match(badInput.error, /input.job: is required/);
  } finally { await fx.cleanup(); }
});

test('an automation iterates, filters, applies policy per item, emits events and persists state', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: {
      state: { initial: { runs: 0 } },
      steps: [
        { id: 'discover', use: 'capability:mock.job-search', with: { query: 'engineer' } },
        { id: 'score', foreach: '{{ steps.discover.output.jobs }}', use: 'skill:evaluate-job', with: { job: '{{ item }}' } },
        { id: 'strong', use: 'filter', with: { source: '{{ steps.score.output }}', where: 'item.score >= 50' } },
        { id: 'research', foreach: '{{ steps.strong.output }}', use: 'skill:company-research', with: { company: '{{ item.company }}' } },
        { id: 'notify', foreach: '{{ steps.score.output }}', use: 'capability:mock.email-send', policy: 'notifyCandidate',
          with: { to: 'owner@example.com', subject: 'New match: {{ item.title }}', score: '{{ item.score }}' } },
        { id: 'announce', foreach: '{{ steps.strong.output }}', use: 'emit', with: { type: 'job.candidate', subject: { type: 'job', id: '{{ item.company }}' }, data: { title: '{{ item.title }}', score: '{{ item.score }}' } } },
        { id: 'never', use: 'transform', when: 'len(steps.strong.output) > 5', with: { value: 'unreachable' } },
        { id: 'remember', use: 'state', with: { set: { runs: '{{ state.runs + 1 }}', lastCount: '{{ len(steps.strong.output) }}' } } },
      ],
      output: { candidates: '{{ steps.strong.output }}', notified: '{{ len(steps.notify.output) }}' },
    } });
    const events = [];
    fx.eventBus.subscribe('job.candidate', (event) => events.push(event));
    const engine = engineFor(fx);
    const run = startAutomation(fx, engine, { trigger: { type: 'manual' } });
    const done = await engine.advance(run.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(done.outputs.candidates.map((c) => c.company), ['Acme', 'Gamma']);
    assert.equal(done.outputs.notified, 2);
    assert.equal(events.length, 2);
    assert.equal(events[0].source, 'package:com.example.jobs');
    assert.equal(events[0].metadata.workflowRunId, run.id);
    assert.deepEqual(getInstanceByAutomation('job-hunter').state, { runs: 1, lastCount: 2 });

    const steps = listSteps(run.id);
    const notify = steps.filter((s) => s.stepId === 'notify');
    assert.deepEqual(notify.map((s) => s.status), ['completed', 'skipped', 'completed']);
    assert.equal(notify[1].policy.decision, 'deny');
    assert.equal(getAgentAction(notify[1].actionId).policy_rule, 'package-policy:notifyCandidate');
    assert.equal(steps.find((s) => s.stepId === 'never').status, 'skipped');
    assert.equal(done.context.never.status, 'skipped');
  } finally { await fx.cleanup(); }
});

test('retries recover transient failures, and exhausted retries fail the run', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, {
      extraExports: [{ id: 'mock.flaky', file: 'capabilities/flaky.yaml' }],
      extraCapabilities: { 'mock.flaky': { id: 'mock.flaky', effect: 'read', permissions: ['code.execute'],
        implementation: { type: 'module', module: 'src/flaky.js', export: 'flaky' } } },
      files: { 'src/flaky.js': 'let calls = 0; export async function flaky(input) { calls += 1; if (calls % 3 !== 0) throw new Error(`transient ${calls}`); return { calls }; }' },
      automation: { steps: [{ id: 'try', use: 'capability:mock.flaky', retry: { attempts: 3 } }] },
    });
    const engine = engineFor(fx);
    const ok = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(ok.status, 'completed', ok.error);
    assert.deepEqual(ok.outputs, { calls: 3 });
    assert.equal(listSteps(ok.id)[0].attempts, 3);

    fx.registries.automations.get('job-hunter').workflow.steps[0].retry = { attempts: 2 };
    const failed = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Step try failed: transient 5/);
  } finally { await fx.cleanup(); }
});

test('a failing step fails the run unless onError is continue', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'bad', use: 'capability:mock.email-send', with: { to: 'x' } },
      { id: 'after', use: 'transform', with: { value: 'reached' } },
    ] } });
    const engine = engineFor(fx);
    const failed = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Invalid input for mock.email-send/);
    assert.equal(getInstanceByAutomation('job-hunter').lastStatus, 'failed');

    fx.registries.automations.get('job-hunter').workflow.steps[0].onError = 'continue';
    const continued = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(continued.status, 'completed');
    assert.equal(continued.outputs, 'reached');
    assert.equal(continued.context.bad.status, 'failed');
  } finally { await fx.cleanup(); }
});

test('runs wait for approval durably and resume after approval', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'ask', use: 'capability:mock.email-send', policy: 'askFirst', with: { to: 'me', subject: 'Apply?' } },
      { id: 'done', use: 'transform', with: { value: '{{ steps.ask.output.subject }}' } },
    ] } });
    const engine = engineFor(fx);
    const waiting = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.wait.type, 'action');
    assert.deepEqual(engine.wakeActionWaits(), []);
    await fx.agent.approveAction(waiting.wait.actionId, 'owner');
    assert.deepEqual(engine.wakeActionWaits(), [waiting.id]);
    const done = await engine.advance(waiting.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.outputs, 'Apply?');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'mock.email-send'").get().n, 1);
  } finally { await fx.cleanup(); }
});

test('a rejected action skips the item instead of failing the run', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'ask', use: 'capability:mock.email-send', policy: 'askFirst', with: { to: 'me', subject: 'Apply?' } },
    ] } });
    const engine = engineFor(fx);
    const waiting = await engine.advance(startAutomation(fx, engine, {}).id);
    await fx.agent.rejectAction(waiting.wait.actionId, 'owner');
    engine.wakeActionWaits();
    const done = await engine.advance(waiting.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.context.ask.status, 'skipped');
  } finally { await fx.cleanup(); }
});

test('sleeping runs survive a restart and resume from their checkpoint without repeating actions', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'send', use: 'capability:mock.email-send', with: { to: 'me', subject: 'first' } },
      { id: 'pause', use: 'sleep', with: { duration: '1h' } },
      { id: 'again', use: 'capability:mock.email-send', with: { to: 'me', subject: 'second' } },
    ] } });
    let now = new Date('2026-09-28T08:00:00Z');
    const first = engineFor(fx, { clock: () => now });
    const waiting = await first.advance(startAutomation(fx, first, {}).id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.wait.type, 'timer');

    // "Restart": a new engine (new worker identity) over the same database.
    const second = engineFor(fx, { clock: () => now });
    assert.deepEqual(second.wakeDueRuns(now), []);
    now = new Date('2026-09-28T09:00:01Z');
    assert.deepEqual(second.wakeDueRuns(now), [waiting.id]);
    const done = await second.advance(waiting.id);
    assert.equal(done.status, 'completed', done.error);
    const sent = getDb().prepare("SELECT arguments FROM agent_actions WHERE tool = 'mock.email-send' ORDER BY created_at").all().map((row) => JSON.parse(row.arguments).subject);
    assert.deepEqual(sent, ['first', 'second']);
  } finally { await fx.cleanup(); }
});

test('a run interrupted mid-step resumes and re-reads the already proposed action', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'send', use: 'capability:mock.email-send', with: { to: 'me', subject: 'once' } },
      { id: 'after', use: 'transform', with: { value: '{{ steps.send.output.subject }}' } },
    ] } });
    const engine = engineFor(fx);
    const run = startAutomation(fx, engine, {});
    // Simulate a crash after the action was proposed and executed but before
    // the step completed: the handle holds the action id, the run is 'running'.
    const outcome = await fx.invoker.invoke('mock.email-send', { to: 'me', subject: 'once' }, { packageId: 'com.example.jobs', automationId: 'job-hunter', workflowRunId: run.id, stepId: 'send' });
    getDb().prepare("UPDATE workflow_runs SET status = 'running', lease_owner = 'dead-worker', position = ? WHERE id = ?")
      .run(JSON.stringify({ step: 0, iteration: 0, items: null, results: [], handle: { actionId: outcome.actionId } }), run.id);
    assert.equal(recoverInterruptedRuns(), 1);
    const done = await engineFor(fx).advance(run.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.outputs, 'once');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'mock.email-send'").get().n, 1);
  } finally { await fx.cleanup(); }
});

test('runs wait for events, match conditions, and time out', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [
      { id: 'reply', use: 'wait', with: { event: 'recruiter.replied', where: 'event.data.company == "Acme"', timeout: '1d' } },
      { id: 'result', use: 'transform', with: { value: '{{ steps.reply.output }}' } },
    ] } });
    let now = new Date(Date.now() - 1000);
    const engine = engineFor(fx, { clock: () => now });
    const waiting = await engine.advance(startAutomation(fx, engine, {}).id);
    assert.equal(waiting.status, 'waiting');
    assert.deepEqual(engine.deliverEvent(fx.eventBus.publish({ type: 'recruiter.replied', data: { company: 'Beta' } })), []);
    const match = fx.eventBus.publish({ type: 'recruiter.replied', data: { company: 'Acme' } });
    assert.deepEqual(engine.deliverEvent(match), [waiting.id]);
    const done = await engine.advance(waiting.id);
    assert.equal(done.outputs.id, match.id);
    assert.equal(done.outputs.data.company, 'Acme');

    const second = await engine.advance(startAutomation(fx, engine, {}).id);
    now = new Date(now.getTime() + 86_400_000 + 1000);
    assert.deepEqual(engine.wakeDueRuns(now), [second.id]);
    const timedOut = await engine.advance(second.id);
    assert.deepEqual(timedOut.outputs, { timedOut: true });
  } finally { await fx.cleanup(); }
});

test('cancelling a waiting run withdraws its pending approval', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [{ id: 'ask', use: 'capability:mock.email-send', policy: 'askFirst', with: { to: 'me', subject: 'x' } }] } });
    const engine = engineFor(fx);
    const waiting = await engine.advance(startAutomation(fx, engine, {}).id);
    const cancelled = engine.cancelRun(waiting.id, 'stopped by owner');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(getAgentAction(waiting.wait.actionId).status, 'cancelled');
    await assert.rejects(() => fx.agent.approveAction(waiting.wait.actionId, 'owner'), /not pending/);
    assert.equal(getRun(waiting.id).status, 'cancelled');
  } finally { await fx.cleanup(); }
});

test('duplicate trigger deliveries create one run', async () => {
  const fx = createPackageFixture();
  try {
    installJobs(fx, { automation: { steps: [{ id: 'x', use: 'transform', with: { value: 1 } }] } });
    const engine = engineFor(fx);
    startAutomation(fx, engine, { dedupeKey: 'event:job-hunter:evt_1' });
    const again = engine.createAutomationRun({ automationId: 'job-hunter', dedupeKey: 'event:job-hunter:evt_1' });
    assert.equal(again.created, false);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM workflow_runs').get().n, 1);
  } finally { await fx.cleanup(); }
});

test('skills from another package act with the calling automation\'s grants, never their own', async () => {
  const fx = createPackageFixture();
  try {
    fx.install({
      manifest: packageManifest('com.example.notes', {
        exports: { capabilities: [{ id: 'notes.send', file: 'c.yaml' }], skills: [{ id: 'send-note', file: 's.yaml' }] },
        permissions: { notifications: { send: true } },
      }),
      capabilities: { 'notes.send': { id: 'notes.send', effect: 'read', permissions: ['notifications.send'], implementation: { type: 'static', output: { sent: '{{ input.text }}' } } } },
      skills: { 'send-note': { id: 'send-note', steps: [{ id: 'send', use: 'capability:notes.send', with: { text: '{{ inputs.text }}' } }] } },
    });
    const withoutGrant = { network: true, notifications: { send: true } };
    assert.throws(() => fx.install({
      manifest: packageManifest('com.example.undeclared', {
        requires: { skills: ['send-note'] }, exports: { automations: [{ id: 'borrower', file: 'a.yaml' }] },
      }),
      automations: { borrower: { id: 'borrower', steps: [{ id: 'note', use: 'skill:send-note', with: { text: 'hi' } }] } },
    }), /requires permission notifications.send, which the package does not declare/);

    fx.install({
      manifest: packageManifest('com.example.caller', {
        requires: { skills: ['send-note'] }, exports: { automations: [{ id: 'caller', file: 'a.yaml' }] }, permissions: withoutGrant,
      }),
      automations: { caller: { id: 'caller', steps: [{ id: 'note', use: 'skill:send-note', with: { text: 'hi' } }] } },
      grant: ['network'],
    });
    const engine = engineFor(fx);
    ensureAutomationInstance({ packageId: 'com.example.caller', automationId: 'caller' });
    const denied = await engine.advance(engine.createAutomationRun({ automationId: 'caller' }).run.id);
    assert.equal(denied.status, 'failed');
    assert.match(denied.error, /not granted: notifications.send/);
    const action = getDb().prepare("SELECT package_context FROM agent_actions WHERE tool = 'notes.send'").get();
    assert.equal(JSON.parse(action.package_context).package, 'com.example.caller');

    const { grantPermissions } = await import('../server/packages/store.js');
    grantPermissions('com.example.caller', ['notifications.send']);
    const allowed = await engine.advance(engine.createAutomationRun({ automationId: 'caller' }).run.id);
    assert.equal(allowed.status, 'completed', allowed.error);
    assert.deepEqual(allowed.outputs, { sent: 'hi' });
  } finally { await fx.cleanup(); }
});
