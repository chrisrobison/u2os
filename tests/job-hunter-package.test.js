import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createPackagePlatform } from '../server/packages/platform.js';
import { getInstanceByAutomation, listRuns } from '../server/packages/workflow-store.js';
import { listPackageAudit } from '../server/packages/store.js';

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'job-hunter');

// The owner's policies.yaml decides whether the simulated email may go out
// without asking: `confirm` (the fail-safe default for an unlisted
// operation) or explicitly delegated `autonomous`.
function boot(dir, { emailPolicy = 'confirm', clock } = {}) {
  const eventBus = new EventBus(getDb());
  const agent = new Agent({ modelProvider: new MockModelProvider(), policyEngine: new PolicyEngine({ policies: { mock: { 'email-send': emailPolicy } } }), toolRegistry: createToolRegistry(), eventBus });
  return { agent, eventBus, ...createPackagePlatform({ agent, eventBus, dataDir: dir, clock }) };
}

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-job-hunter-'));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  return dir;
}

async function done(dir, ...platforms) {
  for (const platform of platforms) await platform?.runtime.stop();
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('the reference package reviews as a coherent, permissioned bundle', async () => {
  const dir = home();
  const p = boot(dir);
  try {
    const review = await p.manager.review(PACKAGE_DIR);
    assert.equal(review.installable, true, review.problems.join('; '));
    assert.deepEqual(review.permissions.map((perm) => perm.permission), ['network', 'notifications.send']);
    assert.deepEqual(review.exports.skills.map((skill) => skill.id), ['normalize-job', 'score-job', 'company-research']);
    assert.deepEqual(review.exports.automations[0].capabilities, ['mock.company-profile', 'mock.email-send', 'mock.job-search']);
    assert.deepEqual(review.policies.map((policy) => [policy.name, policy.approval]), [['notifyCandidate', 'automatic']]);
  } finally { await done(dir, p); }
});

test('scheduled run: search → normalize → score → research → emit → policy-gated notify → durable state', async () => {
  const dir = home();
  let now = new Date(2026, 8, 28, 7, 30); // Monday 07:30 local
  const clock = () => now;
  let first = boot(dir, { clock });
  let second;
  try {
    await first.manager.install(PACKAGE_DIR, { grant: 'all' });
    first.runtime.enable('job-hunter');
    const candidates = [];
    const collect = (event) => candidates.push(event);
    let unsubscribe = first.eventBus.subscribe('job.candidate', collect);

    now = new Date(2026, 8, 28, 8, 0, 30);
    await first.runtime.tick(now);
    let [run] = listRuns({ kind: 'automation' });
    assert.equal(run.trigger.type, 'schedule');
    // policies.yaml says confirm, so the first very strong match waits for the owner.
    assert.equal(run.status, 'waiting', run.error);
    assert.equal(run.wait.type, 'action');
    assert.deepEqual(candidates.map((event) => event.data.title), ['Staff Platform Engineer', 'Senior Backend Engineer', 'Principal Engineer, Privacy']);
    assert.deepEqual(candidates.map((event) => event.data.score), [100, 80, 90]);
    assert.equal(candidates[0].data.openRoles, 2);
    assert.equal(candidates[0].source, 'package:com.u2os.job-hunter');

    // Restart while waiting for approval: a new process, same database.
    unsubscribe();
    await first.runtime.stop();
    second = boot(dir, { clock });
    second.runtime.start({ tickMs: 3_600_000 });
    unsubscribe = second.eventBus.subscribe('job.candidate', collect);
    await second.agent.approveAction(run.wait.actionId, 'owner');
    await second.runtime.tick(now);
    run = listRuns({ kind: 'automation' })[0];
    assert.equal(run.status, 'waiting');
    await second.agent.approveAction(run.wait.actionId, 'owner');
    await second.runtime.tick(now);
    run = listRuns({ kind: 'automation' })[0];
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(run.outputs, { searched: 5, new: 5, candidates: ['Staff Platform Engineer', 'Senior Backend Engineer', 'Principal Engineer, Privacy'] });
    assert.equal(candidates.length, 3, 'nothing was announced twice across the restart');

    const notify = second.runtime.runDetail(run.id).steps.filter((step) => step.stepId === 'notify');
    assert.deepEqual(notify.map((step) => [step.iteration, step.status, step.policy.decision]), [[0, 'completed', 'automatic'], [1, 'skipped', 'deny'], [2, 'completed', 'automatic']]);
    const sent = getDb().prepare("SELECT arguments, status, package_context FROM agent_actions WHERE tool = 'mock.email-send' ORDER BY created_at").all();
    assert.deepEqual(sent.map((row) => row.status), ['executed', 'blocked', 'executed']);
    assert.match(JSON.parse(sent[0].arguments).subject, /Strong match: Staff Platform Engineer at Acme Robotics \(100\)/);
    assert.equal(JSON.parse(sent[1].package_context).policy.name, 'notifyCandidate');

    const state = getInstanceByAutomation('job-hunter').state;
    assert.deepEqual(state.seen, ['mock-001', 'mock-002', 'mock-003', 'mock-004', 'mock-005']);
    assert.equal(state.runs, 1);

    // Next weekday: durable state means nothing is new, so nothing is announced.
    now = new Date(2026, 8, 29, 8, 0, 30);
    await second.runtime.tick(now);
    const next = listRuns({ kind: 'automation' })[0];
    assert.equal(next.status, 'completed');
    assert.deepEqual(next.outputs, { searched: 5, new: 0, candidates: [] });
    assert.equal(candidates.length, 3);

    const audit = listPackageAudit({ packageId: 'com.u2os.job-hunter', automationId: 'job-hunter' });
    assert.ok(audit.some((entry) => entry.action === 'mock.job-search' && entry.status === 'executed'));
    const research = audit.filter((entry) => entry.action === 'mock.company-profile' && entry.context.rootRun === run.id);
    assert.equal(research.length, 3, 'research is attributed to the automation run that initiated it');
    assert.ok(research.every((entry) => entry.context.skill === 'company-research' && entry.context.run !== run.id));
    assert.equal(listPackageAudit({ runId: run.id }).filter((entry) => entry.action === 'mock.company-profile').length, 3);
  } finally { await done(dir, first, second); }
});

test('delegated authority: with mock.email-send autonomous, strong matches are emailed without asking', async () => {
  const dir = home();
  const p = boot(dir, { emailPolicy: 'autonomous' });
  try {
    await p.manager.install(PACKAGE_DIR, { grant: 'all' });
    p.manager.configure('com.u2os.job-hunter', { settings: { autoNotifyScore: 95 } });
    p.runtime.enable('job-hunter');
    p.runtime.start({ tickMs: 3_600_000 });
    p.eventBus.publish({ type: 'job.search.requested', data: { query: 'privacy' } });
    await p.runtime.drain();
    const [run] = listRuns({ kind: 'automation' });
    assert.equal(run.trigger.type, 'event');
    assert.equal(run.inputs.query, 'privacy');
    assert.equal(run.status, 'completed', run.error);
    const statuses = getDb().prepare("SELECT status FROM agent_actions WHERE tool = 'mock.email-send' ORDER BY created_at").all().map((row) => row.status);
    assert.deepEqual(statuses, ['executed', 'blocked', 'blocked']);

    // The owner can tighten the package policy without editing package files.
    p.manager.configure('com.u2os.job-hunter', { policies: { notifyCandidate: 'never' } });
    getDb().prepare("UPDATE automation_instances SET state = json_set(state, '$.seen', json('[]'))").run();
    await p.runtime.runNow('job-hunter');
    const newest = getDb().prepare("SELECT status, policy_rule FROM agent_actions WHERE tool = 'mock.email-send' ORDER BY created_at DESC LIMIT 3").all();
    assert.ok(newest.every((row) => row.status === 'blocked' && row.policy_rule === 'package-policy:notifyCandidate'));
  } finally { await done(dir, p); }
});
