import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createPackagePlatform } from '../server/packages/platform.js';
import { getInstanceByAutomation, listRuns } from '../server/packages/workflow-store.js';
import { listGrants } from '../server/packages/store.js';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-pkgmgr-'));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  return dir;
}

function platform(dir) {
  const db = getDb();
  const eventBus = new EventBus(db);
  const agent = new Agent({ modelProvider: new MockModelProvider(), policyEngine: new PolicyEngine({ policies: { demo: { 'send-note': 'autonomous' } } }), toolRegistry: createToolRegistry(), eventBus });
  return { agent, eventBus, ...createPackagePlatform({ agent, eventBus, dataDir: dir }) };
}

function cleanup(dir, ...platforms) {
  return Promise.all(platforms.map((p) => p?.runtime.stop())).then(() => {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** Writes a package directory. `files` values may be objects (YAML) or strings. */
function writePackage(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : name.endsWith('.json') ? JSON.stringify(content) : yaml.dump(content));
  }
  return root;
}

function notesPackage(root, { version = '1.0.0', permissions = { notifications: { send: true } }, extra = {} } = {}) {
  return writePackage(root, {
    'u2os.yaml': {
      apiVersion: 'u2os/v1', kind: 'Package',
      metadata: { id: 'com.example.notes', name: 'Notes', version, description: 'Sends notes.' },
      requires: { u2os: '>=0.1.0' },
      exports: {
        capabilities: [{ id: 'demo.send-note', file: 'capabilities/send-note.yaml' }],
        skills: [{ id: 'compose-note', file: 'skills/compose-note.yaml' }],
        automations: [{ id: 'note-taker', entrypoint: 'automations/note-taker.yaml' }],
      },
      permissions,
      policies: { sendNotes: { all: ['input.text != ""'], approval: 'automatic' } },
      settings: { greeting: { type: 'string', default: 'Hello' } },
      secrets: ['notes.token'],
      events: { emits: ['note.sent'] },
    },
    'capabilities/send-note.yaml': { id: 'demo.send-note', effect: 'write', permissions: ['notifications.send'],
      inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      implementation: { type: 'static', output: { sent: '{{ input.text }}' } } },
    'skills/compose-note.yaml': { id: 'compose-note', steps: [{ id: 'text', use: 'transform', with: { value: '{{ settings.greeting }}, {{ inputs.name }}' } }] },
    'automations/note-taker.yaml': { id: 'note-taker', triggers: [{ type: 'manual' }], state: { initial: { sent: 0, ...(extra.state || {}) } }, workflow: 'workflows/note.yaml' },
    'workflows/note.yaml': { inputs: { name: { type: 'string', default: 'owner' } }, steps: [
      { id: 'compose', use: 'skill:compose-note', with: { name: '{{ inputs.name }}' } },
      { id: 'send', use: 'capability:demo.send-note', policy: 'sendNotes', with: { text: '{{ steps.compose.output }}' } },
      { id: 'count', use: 'state', with: { set: { sent: '{{ state.sent + 1 }}' } } },
      { id: 'tell', use: 'emit', with: { type: 'note.sent', data: { text: '{{ steps.send.output.sent }}' } } },
    ] },
    'README.md': '# Notes',
    ...extra.files,
  });
}

test('review describes a package without installing it', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    const src = notesPackage(path.join(dir, 'src'));
    const review = await p.manager.review(src);
    assert.equal(review.id, 'com.example.notes');
    assert.equal(review.installable, true);
    assert.deepEqual(review.permissions, [{ permission: 'notifications.send', description: 'send you notifications', sensitive: false }]);
    assert.deepEqual(review.policies.map((policy) => [policy.name, policy.approval]), [['sendNotes', 'automatic']]);
    assert.deepEqual(review.exports.automations[0].permissions, ['notifications.send']);
    assert.equal(p.manager.list().length, 0);
  } finally { await cleanup(dir, p); }
});

test('installing from a directory copies, validates and registers without running package code or enabling automations', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    const marker = path.join(dir, 'ran.txt');
    const src = notesPackage(path.join(dir, 'src'), { extra: { files: { 'src/side-effect.js': `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x');` } } });
    const installed = await p.manager.install(src);
    assert.equal(installed.version, '1.0.0');
    assert.equal(fs.existsSync(marker), false);
    assert.ok(fs.existsSync(path.join(dir, 'packages', 'com.example.notes', '1.0.0', 'u2os.yaml')));
    assert.ok(p.registries.skills.has('compose-note'));
    assert.ok(p.agent.toolRegistry.has('demo.send-note'));
    assert.equal(getInstanceByAutomation('note-taker').enabled, false);
    assert.deepEqual(listGrants('com.example.notes'), []);
    assert.throws(() => p.runtime.enable('note-taker'), /Grant com.example.notes these permissions/);

    p.manager.grant('com.example.notes', 'all');
    p.runtime.enable('note-taker');
    const run = await p.runtime.runNow('note-taker', { name: 'Chris' });
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(getInstanceByAutomation('note-taker').state, { sent: 1 });

    p.manager.configure('com.example.notes', { settings: { greeting: 'Hi' } });
    const again = await p.runtime.runNow('note-taker', { name: 'Chris' });
    assert.equal(p.runtime.runDetail(again.id).steps.find((s) => s.stepId === 'send').output.sent, 'Hi, Chris');
    assert.throws(() => p.manager.configure('com.example.notes', { settings: { greeting: 5 } }), /expected string/);
    assert.throws(() => p.manager.grant('com.example.notes', ['email.send']), /does not declare: email.send/);
  } finally { await cleanup(dir, p); }
});

test('malformed packages, unsafe paths, symlinks and missing dependencies are refused', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    const bad = writePackage(path.join(dir, 'bad'), { 'u2os.yaml': { apiVersion: 'u2os/v1', kind: 'Package', metadata: { id: 'Bad', name: '', version: 'x' } } });
    await assert.rejects(() => p.manager.install(bad), (error) => error.code === 'MANIFEST_INVALID' && error.errors.length >= 3);

    const traversal = notesPackage(path.join(dir, 'traversal'));
    const manifest = yaml.load(fs.readFileSync(path.join(traversal, 'u2os.yaml'), 'utf8'));
    manifest.exports.skills[0].file = '../../outside.yaml';
    fs.writeFileSync(path.join(traversal, 'u2os.yaml'), yaml.dump(manifest));
    await assert.rejects(() => p.manager.install(traversal), /package-relative/);

    const linked = notesPackage(path.join(dir, 'linked'));
    fs.symlinkSync('/etc/hostname', path.join(linked, 'workflows', 'link.yaml'));
    await assert.rejects(() => p.manager.install(linked), /symbolic links/);

    const dependent = writePackage(path.join(dir, 'dependent'), {
      'u2os.yaml': { apiVersion: 'u2os/v1', kind: 'Package', metadata: { id: 'com.example.dependent', name: 'Dependent', version: '1.0.0' },
        requires: { skills: { 'company-research': '^1.0' } } },
    });
    await assert.rejects(() => p.manager.install(dependent), (error) => error.status === 409 && /missing skill company-research/.test(error.message));
    assert.equal(p.manager.list().length, 0);
    await assert.rejects(() => p.manager.install('https://example.com/not-a-repo'), /Only local paths/);
  } finally { await cleanup(dir, p); }
});

test('packages install from tar.gz archives and git repositories; unsafe archives are refused', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    const src = notesPackage(path.join(dir, 'work', 'notes'));
    const archive = path.join(dir, 'notes.tgz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'work'), 'notes']);
    assert.equal((await p.manager.install(archive)).source.type, 'archive');
    p.manager.uninstall('com.example.notes');

    const repo = path.join(dir, 'repo');
    fs.cpSync(src, repo, { recursive: true });
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
    assert.equal((await p.manager.install(`git+file://${repo}`)).source.type, 'git');

    const evil = path.join(dir, 'evil.tar');
    execFileSync('tar', ['-cPf', evil, path.join(src, 'README.md')]);
    await assert.rejects(() => p.manager.install(evil), /Unsafe archive entry/);
    const linkDir = path.join(dir, 'linkpkg');
    fs.mkdirSync(linkDir);
    fs.symlinkSync('/etc/passwd', path.join(linkDir, 'u2os.yaml'));
    const linkArchive = path.join(dir, 'link.tar');
    execFileSync('tar', ['-cf', linkArchive, '-C', dir, 'linkpkg']);
    await assert.rejects(() => p.manager.install(linkArchive), /links or special files/);
  } finally { await cleanup(dir, p); }
});

test('installed packages, grants and automation state survive a restart', async () => {
  const dir = home();
  let first = platform(dir);
  let second;
  try {
    await first.manager.install(notesPackage(path.join(dir, 'src')), { grant: 'all' });
    first.runtime.enable('note-taker');
    await first.runtime.runNow('note-taker');
    await first.runtime.stop();
    second = platform(dir);
    assert.ok(second.registries.automations.has('note-taker'));
    assert.ok(second.agent.toolRegistry.has('demo.send-note'));
    assert.equal(second.manager.list()[0].loaded, true);
    const run = await second.runtime.runNow('note-taker');
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(getInstanceByAutomation('note-taker').state, { sent: 2 });
  } finally { await cleanup(dir, first, second); }
});

test('disable, uninstall and reinstall: history and user state are kept, dependents protected', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    await p.manager.install(notesPackage(path.join(dir, 'src')), { grant: 'all' });
    p.manager.configure('com.example.notes', { settings: { greeting: 'Yo' } });
    const consumer = writePackage(path.join(dir, 'consumer'), {
      'u2os.yaml': { apiVersion: 'u2os/v1', kind: 'Package', metadata: { id: 'com.example.consumer', name: 'Consumer', version: '1.0.0' },
        requires: { skills: ['compose-note'] }, exports: { skills: [{ id: 'wrap-note', file: 's.yaml' }] } },
      's.yaml': { id: 'wrap-note', steps: [{ id: 'inner', use: 'skill:compose-note', with: { name: 'x' } }] },
    });
    await p.manager.install(consumer);
    assert.throws(() => p.manager.uninstall('com.example.notes'), /required by com.example.consumer/);

    p.manager.setEnabled('com.example.notes', false);
    await assert.rejects(() => p.runtime.runNow('note-taker'), /disabled/);
    p.manager.setEnabled('com.example.notes', true);
    p.runtime.enable('note-taker');
    await p.runtime.runNow('note-taker');

    p.manager.uninstall('com.example.consumer');
    const result = p.manager.uninstall('com.example.notes');
    assert.equal(result.uninstalled, true);
    assert.equal(fs.existsSync(path.join(dir, 'packages', 'com.example.notes')), false);
    assert.equal(p.registries.automations.has('note-taker'), false);
    assert.equal(p.agent.toolRegistry.has('demo.send-note'), false);
    assert.equal(getInstanceByAutomation('note-taker').status, 'uninstalled');
    assert.equal(listRuns({ kind: 'automation' }).length, 1);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE requested_by = 'package:com.example.notes'").get().n, 1);

    const reinstalled = await p.manager.install(notesPackage(path.join(dir, 'src2')));
    assert.equal(reinstalled.enabled, true);
    assert.equal(reinstalled.settings.values.greeting, 'Yo');
    assert.equal(getInstanceByAutomation('note-taker').enabled, false);
    assert.deepEqual(getInstanceByAutomation('note-taker').state, { sent: 1 });
    assert.ok(reinstalled.permissions.every((permission) => permission.granted === false));
  } finally { await cleanup(dir, p); }
});

test('upgrades replace files, drop grants no longer declared and merge new state keys', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    await p.manager.install(notesPackage(path.join(dir, 'v1'), { permissions: { notifications: { send: true }, network: true } }), { grant: 'all' });
    p.runtime.enable('note-taker');
    await p.runtime.runNow('note-taker');
    p.manager.setEnabled('com.example.notes', false);
    p.manager.setEnabled('com.example.notes', true);
    const upgraded = await p.manager.install(notesPackage(path.join(dir, 'v2'), { version: '1.1.0', extra: { state: { lastSeen: null } } }));
    assert.equal(upgraded.enabled, true);
    assert.equal(upgraded.version, '1.1.0');
    assert.ok(!fs.existsSync(path.join(dir, 'packages', 'com.example.notes', '1.0.0')));
    assert.deepEqual(listGrants('com.example.notes'), ['notifications.send']);
    assert.deepEqual(getInstanceByAutomation('note-taker').state, { sent: 1, lastSeen: null });
    assert.equal(getInstanceByAutomation('note-taker').enabled, true);
  } finally { await cleanup(dir, p); }
});

test('package secrets are stored encrypted by declared name only', async () => {
  const dir = home();
  const p = platform(dir);
  try {
    await p.manager.install(notesPackage(path.join(dir, 'src')));
    assert.deepEqual(p.manager.setSecret('com.example.notes', 'notes.token', 's3cret-value'), [{ name: 'notes.token', configured: true }]);
    assert.throws(() => p.manager.setSecret('com.example.notes', 'other.token', 'x'), /does not declare secret/);
    const stored = fs.readdirSync(path.join(dir, 'credentials')).filter((name) => name.startsWith('package--'));
    assert.equal(stored.length, 1);
    assert.ok(!fs.readFileSync(path.join(dir, 'credentials', stored[0]), 'utf8').includes('s3cret-value'));
    assert.deepEqual(p.manager.get('com.example.notes').secrets, [{ name: 'notes.token', configured: true }]);
  } finally { await cleanup(dir, p); }
});
