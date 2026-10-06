import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddonManifestError, parseAddonYaml, safeAddonPath, validateAddonManifest } from '../server/addons/manifest.js';

const valid = () => ({
  apiVersion: 'u2os/v1', kind: 'Addon',
  metadata: { id: 'apple', name: 'Apple apps', version: '0.1.0', description: 'Mail, Calendar and more' },
  requires: { platform: ['darwin'], commands: ['bunx'], u2os: '>=0.1.0' },
  servers: { apple: { command: 'bunx', args: ['apple-mcp@1.0.0'], timeout_seconds: 60, tools: {
    mail_unread: { tool: 'mail', fixed: { operation: 'unread' }, read: true, classification: 'personal', description: 'Unread mail' },
    mail_send: { tool: 'mail', fixed: { operation: 'send' } },
  } } },
  settings: { limit: { type: 'number', default: 10, description: 'Rows' } },
  skills: ['skills/inbox.md'], routines: ['routines/morning.md'],
  ui: { nav: [{ id: 'apple', title: 'Apple', icon: 'apple-whole', group: 'Add-ons' }] },
});
const errorsOf = (mutate) => { const raw = valid(); mutate(raw); try { validateAddonManifest(raw); return []; } catch (e) { assert.ok(e instanceof AddonManifestError); return e.errors; } };
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);

test('a complete manifest validates and is normalized, with tool claims kept as suggestions', () => {
  const m = validateAddonManifest(valid());
  assert.equal(m.id, 'apple');
  const [server] = m.servers;
  assert.equal(server.tools[0].name, 'mail_unread');
  assert.equal(server.tools[0].remote, 'mail');
  assert.deepEqual(server.tools[0].fixed, { operation: 'unread' });
  assert.equal(server.tools[0].suggestedRead, true);
  assert.equal(server.tools[1].suggestedRead, false);
  assert.equal(server.tools[1].suggestedClassification, 'private');
  assert.deepEqual(m.ui.nav[0], { id: 'apple', title: 'Apple', icon: 'apple-whole', group: 'Add-ons' });
  assert.equal(m.requires.platform[0], 'darwin');
});

test('yaml parsing uses the core schema and a size cap', () => {
  assert.equal(parseAddonYaml('kind: Addon\n').kind, 'Addon');
  assert.throws(() => parseAddonYaml('a: !!js/function "x"'), AddonManifestError);
  assert.throws(() => parseAddonYaml('x: ' + 'a'.repeat(70 * 1024)), /larger than/);
});

test('rejects unknown keys, bad identity and reserved or foreign names', () => {
  has(errorsOf((m) => { m.extra = 1; }), /extra: unknown top-level key/);
  has(errorsOf((m) => { m.kind = 'Package'; }), /kind: must be Addon/);
  has(errorsOf((m) => { m.metadata.id = 'Bad-Id'; }), /metadata.id/);
  has(errorsOf((m) => { m.metadata.id = 'email'; m.servers = { email: m.servers.apple }; }), /reserved/);
  has(errorsOf((m) => { m.servers = { calendar: m.servers.apple }; }), /reserved/);
  has(errorsOf((m) => { m.servers = { other: m.servers.apple }; }), /must be the add-on id/);
});

test('a server prefixed with the add-on id is allowed', () => {
  assert.deepEqual(errorsOf((m) => { m.servers = { apple_mail: m.servers.apple }; }), []);
});

test('rejects dangerous commands, args, env and hostile tool definitions', () => {
  has(errorsOf((m) => { m.servers.apple.command = 'rm -rf /'; }), /command/);
  has(errorsOf((m) => { m.servers.apple.command = '../evil'; }), /command/);
  has(errorsOf((m) => { m.servers.apple.command = '${ADDON_DIR}/../evil'; }), /command/);
  assert.deepEqual(errorsOf((m) => { m.servers.apple.command = '${ADDON_DIR}/server.js'; }), []);
  has(errorsOf((m) => { m.servers.apple.args = [{ a: 1 }]; }), /args/);
  has(errorsOf((m) => { m.servers.apple.env = { 'BAD NAME': 'x' }; }), /env/);
  has(errorsOf((m) => { m.servers.apple.timeout_seconds = 5000; }), /timeout_seconds/);
  has(errorsOf((m) => { m.servers.apple.tools = {}; }), /at least one tool/);
  has(errorsOf((m) => { m.servers.apple.tools['bad name'] = {}; }), /tool names use/);
  has(errorsOf((m) => { m.servers.apple.tools.mail_send.fixed = { nested: { a: 1 } }; }), /fixed/);
  has(errorsOf((m) => { m.servers.apple.tools.mail_send.classification = 'secret'; }), /classification/);
  has(errorsOf((m) => { m.servers.apple.tools.mail_send.surprise = true; }), /unknown key/);
  has(errorsOf((m) => { m.servers.apple.tools.mail_send.read = 'yes'; }), /read/);
});

test('rejects path escapes in skills and routines, and bad settings and navigation', () => {
  for (const bad of ['../x.md', '/etc/passwd.md', 'a/../b.md', '.hidden/x.md', 'x.txt', 'a\\b.md']) has(errorsOf((m) => { m.skills = [bad]; }), /skills/);
  has(errorsOf((m) => { m.routines = 'nope'; }), /routines/);
  has(errorsOf((m) => { m.settings.limit.default = 'ten'; }), /default/);
  has(errorsOf((m) => { m.settings.limit.type = 'object'; }), /type/);
  has(errorsOf((m) => { m.ui.nav[0].id = 'Bad'; }), /ui.nav\[0\].id/);
  has(errorsOf((m) => { m.ui.nav = Array(6).fill(m.ui.nav[0]); }), /at most|up to 5/);
  has(errorsOf((m) => { m.ui.pages = []; }), /ui.pages: unknown key/);
  has(errorsOf((m) => { m.requires.platform = ['plan9']; }), /platform/);
  has(errorsOf((m) => { m.requires.commands = ['a b']; }), /commands/);
});

test('an add-on must contribute something', () => {
  has(errorsOf((m) => { delete m.servers; delete m.skills; delete m.routines; }), /at least one of/);
});

test('safeAddonPath', () => {
  assert.equal(safeAddonPath('skills/a.md'), 'skills/a.md');
  assert.equal(safeAddonPath('../a.md'), null);
  assert.equal(safeAddonPath('a//b'), null);
  assert.equal(safeAddonPath(5), null);
});
