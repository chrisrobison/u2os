import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { getPolicySourceStatus } from '../server/policy/policies-loader.js';
import { exportMemoryToVault } from '../server/vault/exporter.js';
import { getVaultDir } from '../server/vault/vault-dir.js';
import { startServer } from './helpers/authed-server.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-policy-'));
  process.env.U2OS_HOME = dir;
  t.after(() => { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); });
  const vault = getVaultDir();
  fs.mkdirSync(vault, { recursive: true });
  let version = 0;
  // Different content each time so the change signature always moves.
  const writePolicy = (text) => fs.writeFileSync(path.join(vault, 'policies.yaml'), `${text}\n# v${version++}\n`);
  return { vault, writePolicy };
}

const tool = (name, category = 'consequential') => ({ name, domain: name.split('.')[0], category });
const decide = (engine, name, context = {}) => {
  const result = engine.evaluate({ tool: tool(name), context });
  return result.blocked ? 'blocked' : result.requiresApproval ? 'confirm' : 'allowed';
};

test('without a vault policy the home policy applies unchanged', (t) => {
  fixture(t);
  const engine = new PolicyEngine();
  const loaded = engine.policies;
  engine.evaluate({ tool: tool('tasks.create') });
  assert.equal(engine.policies, loaded, 'a fresh home does not reload on its first decision');
  assert.equal(decide(engine, 'tasks.create'), 'allowed');
  assert.equal(decide(engine, 'calendar.reschedule', { category: 'personal' }), 'confirm');
  assert.equal(getPolicySourceStatus().active, false);
});

test('a valid vault policy overrides per operation and applies without a restart', (t) => {
  const { writePolicy } = fixture(t);
  const engine = new PolicyEngine();
  writePolicy('tasks:\n  create: confirm\ncalendar:\n  reschedule:\n    personal: autonomous\n    default: confirm');
  assert.equal(decide(engine, 'tasks.create'), 'confirm', 'the vault tightened this');
  assert.equal(decide(engine, 'tasks.complete'), 'allowed', 'unlisted operations keep the home policy');
  assert.equal(decide(engine, 'notifications.send'), 'allowed', 'unlisted domains keep the home policy');
  assert.equal(decide(engine, 'calendar.reschedule', { category: 'personal' }), 'allowed', 'the owner may delegate more');
  assert.equal(decide(engine, 'calendar.reschedule', {}), 'confirm', 'sub-categories still come only from authoritative context');
  assert.equal(getPolicySourceStatus().active, true);

  writePolicy('tasks:\n  create: never');
  assert.equal(decide(engine, 'tasks.create'), 'blocked', 'an edit applies on the next decision');
});

test('an invalid vault policy fails closed: nothing autonomous, blocks still apply', (t) => {
  const { writePolicy } = fixture(t);
  const engine = new PolicyEngine();
  for (const broken of ['tasks:\n  create: sometimes', 'tasks: [create]', 'tasks:\n  create: [unclosed', 'just text']) {
    writePolicy(broken);
    assert.equal(decide(engine, 'tasks.create'), 'confirm', broken);
    assert.equal(decide(engine, 'notifications.send'), 'confirm', 'even operations the broken file did not mention');
    assert.equal(decide(engine, 'payments.over_50'), 'blocked');
    assert.equal(engine.evaluate({ tool: tool('email.read', 'read') }).requiresApproval, false, 'reads are unaffected');
    assert.ok(getPolicySourceStatus().error, 'the problem is reported');
  }
  assert.match(engine.evaluate({ tool: tool('tasks.create') }).rule, /vault-policy-invalid$/);
  assert.match(engine.evaluate({ tool: tool('tasks.create') }).reason, /policies\.yaml is invalid/);
});

test('export moves the current policy into the vault without changing any decision', (t) => {
  const { vault } = fixture(t);
  const before = new PolicyEngine();
  const names = ['tasks.create', 'email.send', 'notifications.send', 'payments.over_50', 'calendar.create'];
  const decisions = names.map((name) => decide(before, name, { category: 'business' }));
  const report = exportMemoryToVault();
  assert.ok(report.written.includes('policies.yaml'));
  const after = new PolicyEngine();
  assert.equal(getPolicySourceStatus().active, true);
  assert.deepEqual(names.map((name) => decide(after, name, { category: 'business' })), decisions);
  fs.writeFileSync(path.join(vault, 'policies.yaml'), 'tasks:\n  create: never\n');
  assert.deepEqual(exportMemoryToVault().skippedExisting, ['policies.yaml'], 'an existing vault policy is never replaced');
});

test('the vault API reports the policy file status', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-policy-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(process.env.U2OS_VAULT, 'policies.yaml'), 'tasks:\n  create: maybe\n');
  const status = await (await fetch(`http://127.0.0.1:${handle.port}/api/vault`)).json();
  assert.equal(status.policy.active, false);
  assert.match(status.policy.error, /tasks\.create/);
});
