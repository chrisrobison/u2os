import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledAddonsDir, discoverAddons, describeAddons } from '../server/addons/registry.js';
import { loadAddonServerSpecs } from '../server/addons/runtime.js';

test('every bundled add-on has a valid manifest and a README', () => {
  const found = discoverAddons({ installedDir: path.join(os.tmpdir(), 'u2os-no-such-dir'), platform: 'darwin', env: { PATH: '' } });
  const bundled = found.filter((a) => a.tier === 'bundled');
  assert.ok(bundled.length >= 1);
  for (const addon of bundled) {
    assert.notEqual(addon.state, 'invalid', `${addon.id}: ${addon.problems.join('; ')}`);
    assert.ok(addon.readme.length > 100, `${addon.id} needs a README`);
    assert.ok(fs.existsSync(path.join(bundledAddonsDir(), addon.id, 'addon.yaml')));
  }
});

// What apple-mcp 1.0.0 offers (checked against the real server's tools/list).
const APPLE_OPERATIONS = {
  calendar: ['search', 'open', 'list', 'create'],
  contacts: null,
  mail: ['unread', 'search', 'send', 'mailboxes', 'accounts', 'latest'],
  maps: ['search', 'save', 'directions', 'pin', 'listGuides', 'addToGuide', 'createGuide'],
  messages: ['send', 'read', 'schedule', 'unread'],
  notes: ['search', 'list', 'create'],
  reminders: ['list', 'search', 'open', 'create', 'listById'],
};
// Operations that only look things up. Anything else must never be suggested read-only.
const LOOKUPS = new Set(['list', 'search', 'unread', 'latest', 'accounts', 'mailboxes', 'read', 'listById', 'directions', 'listGuides']);

function apple(platform = 'darwin') {
  return discoverAddons({ installedDir: path.join(os.tmpdir(), 'u2os-no-such-dir'), platform, env: { PATH: '' } }).find((a) => a.id === 'apple');
}

test('apple add-on: pinned server, macOS only, every variant maps to a real operation', () => {
  const entry = apple();
  assert.equal(entry.tier, 'bundled'); assert.equal(entry.state, 'available');
  assert.equal(apple('linux').state, 'unsupported');
  const [server] = entry.manifest.servers;
  assert.equal(server.command, 'bunx');
  assert.match(server.args[0], /^apple-mcp@\d+\.\d+\.\d+$/, 'the server version is pinned');
  for (const tool of server.tools) {
    assert.ok(tool.remote in APPLE_OPERATIONS, `${tool.name}: unknown server tool ${tool.remote}`);
    const operations = APPLE_OPERATIONS[tool.remote];
    if (operations) {
      assert.ok(operations.includes(tool.fixed.operation), `${tool.name}: ${tool.fixed.operation} is not an operation of ${tool.remote}`);
      assert.ok(tool.fixed.operation !== 'open', 'opening items in apps is not offered');
    }
  }
});

test('apple add-on: only lookups are suggested read-only, and a send/create never is', () => {
  const tools = apple().manifest.servers[0].tools;
  for (const tool of tools) {
    if (tool.suggestedRead) assert.ok(tool.remote === 'contacts' || LOOKUPS.has(tool.fixed.operation), `${tool.name} must not be suggested read-only`);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const send of ['mail_send', 'messages_send', 'messages_schedule', 'calendar_create', 'notes_create', 'reminders_create']) assert.equal(byName[send].suggestedRead, false, send);
  for (const lookup of ['mail_unread', 'calendar_list', 'contacts_search', 'maps_search']) assert.equal(byName[lookup].suggestedRead, true, lookup);
  // message content is private, even as a suggestion
  for (const name of ['mail_unread', 'mail_search', 'messages_read', 'notes_search']) assert.equal(byName[name].suggestedClassification, 'private', name);
});

test('apple add-on: enabled but unconfirmed, every tool is an action with private results', () => {
  const discovered = discoverAddons({ installedDir: path.join(os.tmpdir(), 'u2os-no-such-dir'), platform: 'darwin', env: { PATH: '' } });
  const decisions = { path: 'x', error: null, addons: { apple: { enabled: true, settings: {}, tools: {} } } };
  const [spec] = loadAddonServerSpecs({ vaultDir: '/v', discovered, decisions });
  assert.equal(spec.name, 'apple'); assert.equal(spec.command, 'bunx'); assert.equal(spec.addonId, 'apple');
  assert.ok(spec.tools.length >= 20);
  for (const tool of spec.tools) { assert.equal(tool.read, false, tool.name); assert.equal(tool.classification, 'private', tool.name); }
  const mailSend = spec.tools.find((t) => t.name === 'mail_send');
  assert.deepEqual(mailSend.fixed, { operation: 'send' }); assert.equal(mailSend.remote, 'mail');
  // and nothing starts without the owner enabling it
  assert.deepEqual(loadAddonServerSpecs({ vaultDir: '/v', discovered, decisions: { path: 'x', error: null, addons: {} } }), []);
  assert.equal(describeAddons({ discovered, decisions: { path: 'x', error: null, addons: {} } }).addons.find((a) => a.id === 'apple').enabled, false);
});
