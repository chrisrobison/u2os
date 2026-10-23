import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, updateAgentAction } from '../server/policy/policy-engine.js';
import { VAULT_POLICY_INVALID } from '../server/policy/policies-loader.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { Agent } from '../server/agent/agent.js';
import { applyRememberedRule, planRemember, patchPoliciesText } from '../server/policy/remember-approval.js';
import { STALE_ACTION_ERROR } from '../server/agent/approval-manager.js';

const pending = (extra = {}) => ({ status: 'pending', ...extra });
const confirmEval = (rule) => ({ blocked: false, requiresApproval: true, rule });
const read = (file) => fs.readFileSync(file, 'utf8');

function tmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-remember-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('plans only plain confirm, one named sub-category, or a missing rule', () => {
  const policies = { jobs: { apply: 'confirm' }, email: { send: { friends: 'autonomous', business: 'confirm', legal: 'never', default: 'confirm' } } };
  const plan = planRemember({ action: pending(), evaluation: confirmEval('jobs.apply:confirm'), policies });
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.domain, plan.operation, plan.subCategory, plan.level], ['jobs', 'apply', null, 'autonomous']);
  assert.equal(planRemember({ action: pending(), evaluation: confirmEval('email.send.business:confirm'), policies }).subCategory, 'business');
  assert.equal(planRemember({ action: pending(), evaluation: confirmEval('mcp.thing:missing'), policies }).ok, true);

  for (const [label, args] of Object.entries({
    default: { action: pending(), evaluation: confirmEval('email.send.default:confirm'), policies },
    fallback: { action: pending(), evaluation: confirmEval('email.send:fallback-confirm'), policies },
    invalidVault: { action: pending(), evaluation: confirmEval('jobs.apply:confirm'), policies: Object.defineProperty({ ...policies }, VAULT_POLICY_INVALID, { value: true }) },
    suffixed: { action: pending(), evaluation: confirmEval('jobs.apply:confirm:vault-policy-invalid'), policies },
    blocked: { action: pending(), evaluation: { ...confirmEval('email.send.legal:never'), blocked: true }, policies },
    notPending: { action: { status: 'failed' }, evaluation: confirmEval('jobs.apply:confirm'), policies },
    package: { action: pending({ packageContext: { packageId: 'x' } }), evaluation: confirmEval('jobs.apply:confirm'), policies },
    stricterGate: { action: pending({ policy_rule: 'goal-scope' }), evaluation: confirmEval('jobs.apply:confirm'), policies },
    wrongCurrent: { action: pending(), evaluation: confirmEval('email.send.friends:confirm'), policies },
  })) assert.equal(planRemember(args).ok, false, label);
});

test('patch keeps comments and other rules, changing only the remembered level', () => tmp((dir) => {
  const file = path.join(dir, 'policies.yaml');
  fs.writeFileSync(file, '# mine\ntasks:\n  create: confirm   # ask first\n\njobs:\n  # careful here\n  apply: confirm\n  search: always\n\nemail:\n  send:\n    friends: autonomous\n    business: confirm # hmm\n    legal: never\n');
  applyRememberedRule({ ok: true, domain: 'jobs', operation: 'apply', subCategory: null, level: 'autonomous' }, { file });
  applyRememberedRule({ ok: true, domain: 'email', operation: 'send', subCategory: 'business', level: 'autonomous' }, { file });
  assert.equal(read(file), '# mine\ntasks:\n  create: confirm   # ask first\n\njobs:\n  # careful here\n  apply: autonomous\n  search: always\n\nemail:\n  send:\n    friends: autonomous\n    business: autonomous # hmm\n    legal: never\n');
}));

test('a sub-category rule copied from home keeps its siblings, including never', () => tmp((dir) => {
  const file = path.join(dir, 'policies.yaml');
  const effective = { email: { read: 'always', send: { friends: 'autonomous', business: 'confirm', legal: 'never' } } };
  applyRememberedRule({ ok: true, domain: 'email', operation: 'send', subCategory: 'business', level: 'autonomous' }, { file, effective });
  assert.deepEqual(yaml.load(read(file)), { email: { send: { friends: 'autonomous', business: 'autonomous', legal: 'never' } } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Domain present in the vault file, operation absent: inserted, others untouched.
  fs.writeFileSync(file, 'email:\n  draft: always\n');
  applyRememberedRule({ ok: true, domain: 'email', operation: 'send', subCategory: 'business', level: 'autonomous' }, { file, effective });
  assert.deepEqual(yaml.load(read(file)), { email: { send: { friends: 'autonomous', business: 'autonomous', legal: 'never' }, draft: 'always' } });
}));

test('layouts the patcher does not understand are refused without writing', () => tmp((dir) => {
  const file = path.join(dir, 'policies.yaml');
  const plan = { ok: true, domain: 'jobs', operation: 'apply', subCategory: null, level: 'autonomous' };
  for (const text of ['jobs: { apply: confirm }\n', 'jobs:\n    apply: confirm\n', 'jobs:\n  apply: "confirm"\n']) {
    fs.writeFileSync(file, text);
    assert.throws(() => applyRememberedRule(plan, { file }), /layout|exactly/);
    assert.equal(read(file), text);
  }
  fs.writeFileSync(file, 'jobs:\n  apply: sometimes\n');
  assert.throws(() => applyRememberedRule(plan, { file }), /use always/);
  assert.equal(patchPoliciesText('jobs:\n  apply: confirm\n', plan, 'autonomous'), 'jobs:\n  apply: autonomous\n');
}));

function setup(dir, homePolicies) {
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(dir, 'home', 'policies'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home', 'policies', 'policies.yaml'), homePolicies);
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'fixture.prepare', domain: 'fixture', category: 'consequential',
    schema: { properties: { value: { type: 'string' } }, required: ['value'] },
    execute: async (args) => { calls.push(args); return { done: true }; },
  });
  const agent = new Agent({
    modelProvider: { id: 'fixture-model', destination: 'local_model', plan: async () => ({
      reasoning_summary: 'Do it', actions: [{ tool: 'fixture.prepare', arguments: { value: 'one' } }],
    }) },
    policyEngine: new PolicyEngine(), toolRegistry: registry, eventBus: new EventBus(getDb()),
  });
  return { agent, calls };
}

async function withHome(homePolicies, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-remember-e2e-'));
  const { agent, calls } = setup(dir, homePolicies);
  try { await fn({ agent, calls, vaultFile: path.join(dir, 'vault', 'policies.yaml') }); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('approve and remember executes now and makes the next identical proposal autonomous', () => withHome('fixture:\n  prepare: confirm\n', async ({ agent, calls, vaultFile }) => {
  const first = await agent.handleMessage({ text: 'Do it', actorId: 'owner' });
  assert.equal(first.actions[0].status, 'pending');
  const preview = agent.previewRememberApproval(first.actions[0].id);
  assert.equal(preview.ok, true);
  const approved = await agent.approveAction(first.actions[0].id, 'owner', { remember: true });
  assert.equal(approved.status, 'executed');
  assert.equal(approved.remembered, true);
  assert.deepEqual(yaml.load(read(vaultFile)), { fixture: { prepare: 'autonomous' } });
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'policy.rule.remembered'").get().n, 1);

  const second = await agent.handleMessage({ text: 'Do it again', actorId: 'owner' });
  assert.notEqual(second.actions[0].status, 'pending');
  assert.equal(calls.length, 2);
}));

test('plain approve never writes policy; a rule that cannot be remembered still approves with a note', () => withHome('fixture:\n  prepare: confirm\n', async ({ agent, vaultFile }) => {
  const first = await agent.handleMessage({ text: 'Do it', actorId: 'owner' });
  assert.equal((await agent.approveAction(first.actions[0].id, 'owner')).status, 'executed');
  assert.equal(fs.existsSync(vaultFile), false);

  fs.writeFileSync(vaultFile, 'fixture: [broken\n');
  const second = await agent.handleMessage({ text: 'Do it', actorId: 'owner' });
  assert.equal(agent.previewRememberApproval(second.actions[0].id).ok, false);
  const approved = await agent.approveAction(second.actions[0].id, 'owner', { remember: true });
  assert.equal(approved.status, 'executed');
  assert.equal(approved.remembered, false);
  assert.match(approved.note, /invalid/);
  assert.equal(read(vaultFile), 'fixture: [broken\n');
}));

test('review again records one fresh pending action for a stale action, only when policy still asks', () => withHome('fixture:\n  prepare: confirm\n', async ({ agent, calls, vaultFile }) => {
  const first = await agent.handleMessage({ text: 'Do it', actorId: 'owner' });
  const id = first.actions[0].id;
  assert.throws(() => agent.reproposeAction(id, 'owner'), /stale/);
  updateAgentAction(id, { status: 'failed', result: { error: STALE_ACTION_ERROR } });

  const next = agent.reproposeAction(id, 'owner');
  assert.equal(next.status, 'pending');
  assert.notEqual(next.id, id);
  assert.equal(next.reproposedFrom, id);
  assert.equal(agent.reproposeAction(id, 'owner').id, next.id);
  assert.equal(calls.length, 0);
  assert.equal((await agent.approveAction(next.id, 'owner')).status, 'executed');
  assert.equal(calls.length, 1);

  const other = await agent.handleMessage({ text: 'Again', actorId: 'owner' });
  updateAgentAction(other.actions[0].id, { status: 'failed', result: { error: STALE_ACTION_ERROR } });
  fs.writeFileSync(vaultFile, 'fixture:\n  prepare: never\n');
  assert.throws(() => agent.reproposeAction(other.actions[0].id, 'owner'), /never/);
  fs.writeFileSync(vaultFile, 'fixture:\n  prepare: autonomous\n');
  assert.throws(() => agent.reproposeAction(other.actions[0].id, 'owner'), /no longer asks/);
}));
