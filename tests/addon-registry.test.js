import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAddons, describeAddons } from '../server/addons/registry.js';
import { loadAddonDecisions, updateAddonDecisions } from '../server/addons/decisions.js';

const MANIFEST = (id, extra = '') => `apiVersion: u2os/v1
kind: Addon
metadata: { id: ${id}, name: ${id} add-on, version: 0.1.0, description: test }
${extra}
servers:
  ${id}:
    command: node
    tools:
      read_thing: { read: true, classification: personal, description: Reads }
      send_thing: { description: Sends }
settings:
  limit: { type: number, default: 5 }
`;

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-addons-'));
  const bundled = path.join(root, 'bundled'); const installed = path.join(root, 'installed'); const vault = path.join(root, 'vault');
  for (const d of [bundled, installed, vault]) fs.mkdirSync(d);
  const add = (dir, id, manifest = MANIFEST(id), readme = '# Hello') => { fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'addon.yaml'), manifest); if (readme) fs.writeFileSync(path.join(dir, id, 'README.md'), readme); };
  return { root, bundled, installed, vault, add, discover: (env) => discoverAddons({ bundledDir: bundled, installedDir: installed, env }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('discovers bundled and installed add-ons, reports invalid ones, and never runs anything', () => {
  const s = scratch();
  try {
    s.add(s.bundled, 'alpha'); s.add(s.installed, 'beta');
    s.add(s.installed, 'broken', 'kind: Nope');
    s.add(s.installed, 'mismatch', MANIFEST('other'));
    fs.mkdirSync(path.join(s.installed, 'empty'));
    const found = s.discover();
    const byId = Object.fromEntries(found.map((a) => [a.id, a]));
    assert.equal(byId.alpha.tier, 'bundled'); assert.equal(byId.alpha.state, 'available'); assert.equal(byId.alpha.readme, '# Hello');
    assert.equal(byId.beta.tier, 'installed');
    assert.equal(byId.broken.state, 'invalid'); assert.ok(byId.broken.problems.length);
    assert.match(byId.mismatch.problems.join(), /must match metadata.id/);
    assert.match(byId.empty.problems.join(), /addon.yaml is missing/);
  } finally { s.cleanup(); }
});

test('a bundled add-on shadows an installed one with the same id', () => {
  const s = scratch();
  try {
    s.add(s.bundled, 'alpha'); s.add(s.installed, 'alpha');
    const alphas = s.discover().filter((a) => a.id === 'alpha');
    assert.equal(alphas.length, 2);
    assert.equal(alphas.find((a) => a.tier === 'installed').state, 'invalid');
    assert.match(alphas.find((a) => a.tier === 'installed').problems[0], /shadowed/);
  } finally { s.cleanup(); }
});

test('platform and command requirements are reported', () => {
  const s = scratch();
  try {
    s.add(s.bundled, 'mac', MANIFEST('mac', 'requires: { platform: [darwin], commands: [definitely-not-a-command-xyz] }'));
    const [entry] = discoverAddons({ bundledDir: s.bundled, installedDir: s.installed, platform: 'linux', env: { PATH: '' } });
    assert.equal(entry.state, 'unsupported'); assert.match(entry.problems[0], /darwin only/);
    const [mac] = discoverAddons({ bundledDir: s.bundled, installedDir: s.installed, platform: 'darwin', env: { PATH: '' } });
    assert.equal(mac.state, 'available'); assert.deepEqual(mac.missingCommands, ['definitely-not-a-command-xyz']);
  } finally { s.cleanup(); }
});

test('addons.yaml: absent means nothing enabled; round trip; invalid file fails closed and is not overwritten', () => {
  const s = scratch();
  try {
    assert.deepEqual(loadAddonDecisions(s.vault).addons, {});
    updateAddonDecisions((a) => { a.alpha = { enabled: true, settings: { limit: 9 }, tools: { read_thing: { read: true, classification: 'personal' } } }; }, s.vault);
    const loaded = loadAddonDecisions(s.vault);
    assert.equal(loaded.error, null); assert.equal(loaded.addons.alpha.enabled, true); assert.equal(loaded.addons.alpha.settings.limit, 9);
    assert.deepEqual(loaded.addons.alpha.tools.read_thing, { read: true, classification: 'personal' });
    // hand edit: honoured
    fs.writeFileSync(path.join(s.vault, 'addons.yaml'), 'addons:\n  alpha:\n    enabled: false\n');
    assert.equal(loadAddonDecisions(s.vault).addons.alpha.enabled, false);
    // invalid: nothing enabled, writes refused, file untouched
    const bad = 'addons:\n  alpha:\n    enabled: yes please\n';
    fs.writeFileSync(path.join(s.vault, 'addons.yaml'), bad);
    const invalid = loadAddonDecisions(s.vault);
    assert.ok(invalid.error); assert.deepEqual(invalid.addons, {});
    assert.throws(() => updateAddonDecisions((a) => { a.alpha = { enabled: true, settings: {}, tools: {} }; }, s.vault), (e) => e.code === 'ADDONS_FILE_INVALID');
    assert.equal(fs.readFileSync(path.join(s.vault, 'addons.yaml'), 'utf8'), bad);
    for (const text of ['addons: 5', 'surprise: 1', 'addons:\n  Bad-Id: {}', 'addons:\n  a:\n    tools:\n      t: { read: true }', 'addons:\n  a:\n    nope: 1']) {
      fs.writeFileSync(path.join(s.vault, 'addons.yaml'), text);
      assert.ok(loadAddonDecisions(s.vault).error, text);
    }
  } finally { s.cleanup(); }
});

test('describeAddons: unconfirmed tools are confirm-required with private results; confirmation applies; invalid file enables nothing', () => {
  const s = scratch();
  try {
    s.add(s.bundled, 'alpha');
    updateAddonDecisions((a) => { a.alpha = { enabled: true, settings: {}, tools: { read_thing: { read: true, classification: 'personal' } } }; }, s.vault);
    const view = describeAddons({ discovered: s.discover(), decisions: loadAddonDecisions(s.vault) }).addons[0];
    assert.equal(view.enabled, true);
    const [read, send] = view.servers[0].tools;
    assert.deepEqual(read.effective, { read: true, classification: 'personal' }); assert.equal(read.confirmed, true);
    assert.deepEqual(send.effective, { read: false, classification: 'private' }); assert.equal(send.confirmed, false);
    assert.equal(view.settings[0].value, 5);
    fs.writeFileSync(path.join(s.vault, 'addons.yaml'), 'garbage: [');
    const closed = describeAddons({ discovered: s.discover(), decisions: loadAddonDecisions(s.vault) });
    assert.equal(closed.addons[0].enabled, false); assert.ok(closed.decisionsError);
  } finally { s.cleanup(); }
});

test('an unconfirmed suggestion never becomes effective even when the manifest says read-only', () => {
  const s = scratch();
  try {
    s.add(s.bundled, 'alpha');
    const view = describeAddons({ discovered: s.discover(), decisions: loadAddonDecisions(s.vault) }).addons[0];
    const read = view.servers[0].tools[0];
    assert.equal(read.suggested.read, true); assert.equal(read.effective.read, false); assert.equal(view.enabled, false);
  } finally { s.cleanup(); }
});
