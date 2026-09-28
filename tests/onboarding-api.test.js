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
