import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';

// Issue #413: the four new/changed route groups the onboarding wizard uses.
// See docs/onboarding.md.

// Deliberately does NOT set U2OS_VAULT: that env var always wins over
// config.json in getVaultDir(), which would make POST /api/vault/location's
// config.json write silently unobservable. Vault defaults to
// <U2OS_HOME>/vault instead, exactly like a real fresh install with no
// vaultDir override.
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-onboarding-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return {
    dir,
    vault: path.join(process.env.U2OS_HOME, 'vault'),
    get: (url) => fetch(`${base}${url}`),
    post: (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
    put: (url, body) => fetch(`${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  };
}

test('onboarding status defaults to incomplete, POST marks it complete idempotently', async (t) => {
  const { get, post } = await fixture(t);
  const initial = await (await get('/api/onboarding')).json();
  assert.deepEqual(initial, { completed: false, completedAt: null });

  const completed = await (await post('/api/onboarding')).json();
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);

  const again = await (await post('/api/onboarding')).json();
  assert.equal(again.completedAt, completed.completedAt, 'a second completion keeps the original timestamp');

  const stillComplete = await (await get('/api/onboarding')).json();
  assert.deepEqual(stillComplete, completed);
});

test('GET /api/vault/me offers a default template when missing, PUT creates and reindexes it', async (t) => {
  const { get, put, vault } = await fixture(t);

  const missing = await get('/api/vault/me');
  assert.equal(missing.status, 200);
  const missingBody = await missing.json();
  assert.equal(missingBody.exists, false);
  assert.match(missingBody.content, /classification: personal/);
  assert.equal(fs.existsSync(path.join(vault, 'me.md')), false, 'GET must never write the file');

  const saveRes = await put('/api/vault/me', { content: '---\nname: Ada\nclassification: personal\n---\nLoves puzzles.\n' });
  assert.equal(saveRes.status, 200);
  const saved = await saveRes.json();
  assert.equal(saved.exists, true);
  assert.equal(saved.error, null);
  assert.ok(saved.report);
  assert.equal(fs.readFileSync(path.join(vault, 'me.md'), 'utf8'), '---\nname: Ada\nclassification: personal\n---\nLoves puzzles.\n');

  const now = await (await get('/api/vault/me')).json();
  assert.equal(now.exists, true);
  assert.match(now.content, /Ada/);
});

test('PUT /api/vault/me rejects unparseable frontmatter without writing the file', async (t) => {
  const { get, put, vault } = await fixture(t);
  const res = await put('/api/vault/me', { content: '---\nname: [unterminated\n---\nBody\n' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /frontmatter|YAML/i);
  assert.equal(fs.existsSync(path.join(vault, 'me.md')), false);

  const stillMissing = await (await get('/api/vault/me')).json();
  assert.equal(stillMissing.exists, false);
});

test('PUT /api/vault/me surfaces a semantically invalid save via the reindex report instead of silently accepting it', async (t) => {
  const { put, vault } = await fixture(t);
  const res = await put('/api/vault/me', { content: '---\nname: Ada\nclassification: not-a-real-level\n---\nBody\n' });
  assert.equal(res.status, 200, 'a raw-text save of syntactically valid YAML is still saved');
  const body = await res.json();
  assert.ok(body.error, 'the invalid classification is reported');
  assert.match(body.error, /classification/i);
  assert.equal(fs.readFileSync(path.join(vault, 'me.md'), 'utf8'), '---\nname: Ada\nclassification: not-a-real-level\n---\nBody\n');
});

test('POST /api/vault/location only relocates an empty vault, with distinct errors otherwise', async (t) => {
  const { post, put, vault, dir } = await fixture(t);

  // Empty vault, non-existent target directory: created and adopted.
  const target = path.join(dir, 'new-vault-location');
  const ok = await post('/api/vault/location', { vaultDir: target });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.vaultDir, target);
  assert.ok(fs.existsSync(path.join(target, 'README.md')), 'the new location gets the standard layout');

  // Now the vault has content (me.md) -- further relocation must be refused.
  const saved = await put('/api/vault/me', { content: '---\nname: Ada\n---\nBody\n' });
  assert.equal(saved.status, 200);
  const notEmpty = await post('/api/vault/location', { vaultDir: path.join(dir, 'another-location') });
  assert.equal(notEmpty.status, 409);
  const notEmptyBody = await notEmpty.json();
  assert.equal(notEmptyBody.code, 'VAULT_NOT_EMPTY');

  // The refused call must not have created the second target directory at all.
  assert.equal(fs.existsSync(path.join(dir, 'another-location')), false);
  // The original pre-relocation vault dir was abandoned in place, untouched.
  assert.equal(fs.existsSync(path.join(vault, 'me.md')), false);
});

test('POST /api/vault/location rejects a non-empty target directory and a target that is not a directory', async (t) => {
  const { post, dir } = await fixture(t);

  const nonEmptyTarget = path.join(dir, 'occupied');
  fs.mkdirSync(nonEmptyTarget, { recursive: true });
  fs.writeFileSync(path.join(nonEmptyTarget, 'existing-file.txt'), 'hi');
  const nonEmptyRes = await post('/api/vault/location', { vaultDir: nonEmptyTarget });
  assert.equal(nonEmptyRes.status, 409);
  assert.equal((await nonEmptyRes.json()).code, 'TARGET_NOT_EMPTY');

  const fileTarget = path.join(dir, 'a-plain-file');
  fs.writeFileSync(fileTarget, 'not a directory');
  const fileRes = await post('/api/vault/location', { vaultDir: fileTarget });
  assert.equal(fileRes.status, 400);
  assert.equal((await fileRes.json()).code, 'TARGET_NOT_DIRECTORY');

  const emptyInputRes = await post('/api/vault/location', { vaultDir: '   ' });
  assert.equal(emptyInputRes.status, 400);
  assert.equal((await emptyInputRes.json()).code, 'INVALID_INPUT');
});

test('POST /api/vault/location refuses to relocate while U2OS_VAULT overrides config.json', async (t) => {
  const { post, dir } = await fixture(t);
  const previous = process.env.U2OS_VAULT;
  process.env.U2OS_VAULT = path.join(dir, 'env-pinned-vault');
  t.after(() => { if (previous === undefined) delete process.env.U2OS_VAULT; else process.env.U2OS_VAULT = previous; });

  const res = await post('/api/vault/location', { vaultDir: path.join(dir, 'wherever') });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'VAULT_ENV_OVERRIDE');
  // Refused before touching config.json or the filesystem target at all.
  assert.equal(fs.existsSync(path.join(dir, 'wherever')), false);
});

test('starter routines: list reflects installed state, install is additive and rejects unknown ids', async (t) => {
  const { get, post, vault } = await fixture(t);

  const before = await (await get('/api/vault/starter-routines')).json();
  assert.ok(before.catalog.length >= 4);
  assert.deepEqual(before.installed, []);
  const morningBrief = before.catalog.find((item) => item.id === 'morning-brief');
  assert.ok(morningBrief);

  const installRes = await post('/api/vault/starter-routines', { ids: ['morning-brief'] });
  assert.equal(installRes.status, 200);
  const installBody = await installRes.json();
  assert.equal(installBody.results.length, 1);
  assert.deepEqual(installBody.results[0].installed, morningBrief.files);
  assert.ok(fs.existsSync(path.join(vault, 'routines/morning-brief.md')));

  const after = await (await get('/api/vault/starter-routines')).json();
  assert.deepEqual(after.installed, ['morning-brief']);

  // Installing again is additive/idempotent -- already-present files are skipped, not overwritten.
  const secondInstall = await (await post('/api/vault/starter-routines', { ids: ['morning-brief'] })).json();
  assert.deepEqual(secondInstall.results[0].installed, []);
  assert.deepEqual(secondInstall.results[0].skipped, morningBrief.files);

  const unknownRes = await post('/api/vault/starter-routines', { ids: ['does-not-exist'] });
  assert.equal(unknownRes.status, 400);

  const emptyRes = await post('/api/vault/starter-routines', { ids: [] });
  assert.equal(emptyRes.status, 400);
});

// Issue #423: point the wizard at an existing vault. Choosing never modifies,
// moves or deletes a file that is already there.
function tree(root) {
  const out = {};
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file); else out[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
  } };
  if (fs.existsSync(root)) walk(root);
  return out;
}
function makeVault(root, extra = {}) {
  const files = {
    'me.md': '---\nname: Existing Owner\nclassification: personal\n---\nMy own notes.\n',
    'people/alice.md': '---\nname: Alice Chen\nrelationship: sister\n---\nAlice.\n',
    'people/bob.md': '---\nname: Bob Ng\n---\nBob.\n',
    'projects/apollo.md': '---\nname: Apollo\n---\nA project.\n',
    'routines/brief.md': '---\nwhen:\n  daily: "07:00"\n---\nBrief me.\n',
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return files;
}
// An mcp.yaml whose server, if it were ever launched, leaves a marker file behind.
const touchSpec = (name, marker) => `servers:\n  ${name}:\n    command: node\n    args: ${JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`])}\n    tools:\n      ping: { read: true }\n`;
const inspect = async (get, target) => (await get(`/api/vault/inspect?path=${encodeURIComponent(target)}`)).json();

test('GET /api/vault/inspect summarizes a candidate folder from names and counts only, and runs nothing', async (t) => {
  const { dir, get } = await fixture(t);
  const marker = path.join(dir, 'server-was-launched');
  const existing = path.join(dir, 'mine');
  makeVault(existing, { 'mcp.yaml': touchSpec('probe', marker) });
  const found = await inspect(get, existing);
  assert.deepEqual([found.exists, found.isDirectory, found.empty, found.writable, found.looksLikeVault], [true, true, false, true, true]);
  assert.deepEqual([found.hasMe, found.hasPolicies, found.hasMcp], [true, false, true]);
  assert.deepEqual(found.counts, { people: 2, projects: 1, commitments: 0, routines: 1, skills: 0 });
  assert.deepEqual(found.mcpServers, [{ name: 'probe', enabled: true }]);
  assert.ok(!JSON.stringify(found).includes('My own notes') && !JSON.stringify(found).includes('Alice'), 'no file content is returned');
  assert.equal(fs.existsSync(marker), false, 'inspecting never launches a declared tool server');

  assert.equal((await inspect(get, path.join(dir, 'nowhere'))).exists, false);
  const empty = path.join(dir, 'empty'); fs.mkdirSync(path.join(empty, '.git'), { recursive: true }); fs.writeFileSync(path.join(empty, '.DS_Store'), '');
  const gitOnly = await inspect(get, empty);
  assert.deepEqual([gitOnly.exists, gitOnly.empty, gitOnly.looksLikeVault], [true, true, false]);
  const other = path.join(dir, 'documents'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'taxes.pdf'), 'x');
  assert.deepEqual([(await inspect(get, other)).empty, (await inspect(get, other)).looksLikeVault], [false, false]);
  const file = path.join(dir, 'a-file'); fs.writeFileSync(file, 'x');
  assert.deepEqual([(await inspect(get, file)).exists, (await inspect(get, file)).isDirectory], [true, false]);
  assert.equal((await get('/api/vault/inspect')).status, 400);
  assert.equal((await get(`/api/vault/inspect?path=${encodeURIComponent(path.parse(dir).root)}`)).status, 400);
});

test('adopt: an existing vault is used as-is, its files stay byte-identical and its records are indexed', async (t) => {
  const { dir, vault, get, post, put } = await fixture(t);
  await put('/api/vault/me', { content: '---\nname: Default Home Owner\nclassification: personal\n---\nOld default vault.\n' });
  const oldBefore = tree(vault);
  const existing = path.join(dir, 'my-real-vault');
  const files = makeVault(existing);
  const response = await post('/api/vault/location', { vaultDir: existing, adopt: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.vaultDir, existing); assert.equal(body.previousVaultDir, vault); assert.equal(body.adopted, true); assert.equal(body.unchanged, false);
  const after = tree(existing);
  for (const [file, content] of Object.entries(files)) assert.equal(after[file], content, `${file} is unchanged`);
  const added = Object.keys(after).filter((file) => !(file in files));
  assert.deepEqual(added, ['README.md'], 'only the standard README is added; existing files are never touched');
  assert.deepEqual(tree(vault), { ...oldBefore }, 'the previous vault is left exactly as it was');
  assert.equal((await (await get('/api/vault')).json()).vaultDir, existing);
  const me = await (await get('/api/vault/me')).json();
  assert.equal(me.exists, true); assert.match(me.content, /Existing Owner/);
  assert.ok(body.report.errors.length === 0, JSON.stringify(body.report.errors));
  assert.ok(body.inspection.counts.people === 2);
  // Choosing the location you are already using is a harmless no-op.
  const again = await (await post('/api/vault/location', { vaultDir: existing, adopt: true })).json();
  assert.equal(again.unchanged, true);
});

test('adopt: a non-vault folder with files needs explicit confirmation and none of its files are changed', async (t) => {
  const { dir, post } = await fixture(t);
  const documents = path.join(dir, 'documents');
  fs.mkdirSync(path.join(documents, 'taxes'), { recursive: true }); fs.writeFileSync(path.join(documents, 'taxes', 'return.txt'), 'private'); fs.writeFileSync(path.join(documents, 'notes.md'), 'hello');
  const before = tree(documents);
  const refused = await post('/api/vault/location', { vaultDir: documents, adopt: true });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'TARGET_NOT_A_VAULT');
  assert.deepEqual(tree(documents), before, 'a refused choice writes nothing');
  const accepted = await post('/api/vault/location', { vaultDir: documents, adopt: true, useNonEmpty: true });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).adopted, false);
  const after = tree(documents);
  for (const [file, content] of Object.entries(before)) assert.equal(after[file], content);
  // A file, and a folder that does not exist yet, keep their own outcomes.
  const file = path.join(dir, 'plain-file'); fs.writeFileSync(file, 'x');
  assert.equal((await (await post('/api/vault/location', { vaultDir: file, adopt: true })).json()).code, 'TARGET_NOT_DIRECTORY');
  const fresh = path.join(dir, 'brand', 'new');
  const created = await post('/api/vault/location', { vaultDir: fresh, adopt: true });
  assert.equal(created.status, 200); assert.ok(fs.statSync(path.join(fresh, 'people')).isDirectory());
});

test('adopt: once onboarding is complete a populated vault is still protected, but an empty one may switch', async (t) => {
  const { dir, vault, post, put } = await fixture(t);
  const existing = path.join(dir, 'other-vault'); makeVault(existing);
  await put('/api/vault/me', { content: '---\nname: Owner\nclassification: personal\n---\nHello\n' });
  await post('/api/onboarding');
  const refused = await post('/api/vault/location', { vaultDir: existing, adopt: true });
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'VAULT_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(vault, 'me.md'), 'utf8').includes('Owner'), true);
});

test('adopt: an onboarded owner whose current vault is empty may still switch', async (t) => {
  const { dir, post } = await fixture(t);
  const existing = path.join(dir, 'other-vault'); makeVault(existing);
  await post('/api/onboarding');
  const switched = await post('/api/vault/location', { vaultDir: existing, adopt: true });
  assert.equal(switched.status, 200); assert.equal((await switched.json()).adopted, true);
});

test('adopt: tool servers declared by the chosen vault start only when the owner opts in, and the old ones are unloaded', async (t) => {
  const { dir, post, get } = await fixture(t);
  const marker = path.join(dir, 'launched.txt');
  const spec = (name) => touchSpec(name, marker);
  const withServers = path.join(dir, 'with-servers'); makeVault(withServers, { 'mcp.yaml': spec('probe') });
  const declined = await (await post('/api/vault/location', { vaultDir: withServers, adopt: true })).json();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(marker), false, 'adopting a folder never launches what its mcp.yaml declares');
  assert.deepEqual(declined.mcp.servers, []); assert.equal(declined.mcp.path, path.join(withServers, 'mcp.yaml'));
  assert.deepEqual(declined.inspection.mcpServers, [{ name: 'probe', enabled: true }]);

  const second = path.join(dir, 'second'); makeVault(second, { 'mcp.yaml': spec('probe2') });
  const started = await (await post('/api/vault/location', { vaultDir: second, adopt: true, startToolServers: true })).json();
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(marker), true, 'opting in starts the declared server');
  assert.deepEqual(started.mcp.servers.map((server) => server.name), ['probe2']);
  // Moving on to a vault with no servers unloads the previous vault's.
  const plain = path.join(dir, 'plain'); makeVault(plain);
  const moved = await (await post('/api/vault/location', { vaultDir: plain, adopt: true })).json();
  assert.deepEqual(moved.mcp.servers, []);
  assert.deepEqual((await (await get('/api/vault')).json()).mcp.servers, []);
});
