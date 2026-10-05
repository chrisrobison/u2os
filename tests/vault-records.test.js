import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';
import { slugify, validateRecord, createVaultRecord } from '../server/vault/records.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-records-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const send = (url, method, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, vault: process.env.U2OS_VAULT, get: (url) => fetch(`${base}${url}`), post: (u, b) => send(u, 'POST', b), patch: (u, b) => send(u, 'PATCH', b) };
}

test('slugs are safe file names', () => {
  assert.equal(slugify('Alice Chen'), 'alice-chen');
  assert.equal(slugify('  José  Núñez! '), 'jose-nunez');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('日本語'), 'untitled');
  assert.equal(slugify('a'.repeat(200)).length, 60);
});

test('validation trims, limits and rejects unknown fields and bad dates', () => {
  assert.deepEqual(validateRecord('Project', { name: ' Roof ', fields: { status: 'active', deadline: '2026-12-31' }, notes: ' n ' }),
    { name: 'Roof', fields: { status: 'active', deadline: '2026-12-31' }, notes: 'n' });
  const bad = (type, input, pattern) => assert.throws(() => validateRecord(type, input), pattern);
  bad('Project', {}, /name is required/);
  bad('Project', { name: 'x'.repeat(201) }, /at most 200/);
  bad('Project', { name: 'a\nb' }, /control characters/);
  bad('Project', { name: 'x', fields: { id: 'ent_abc' } }, /not a field/);
  bad('Project', { name: 'x', fields: { classification: 'public' } }, /not a field/);
  bad('Project', { name: 'x', fields: { status: 'someday' } }, /one of/);
  bad('Project', { name: 'x', fields: { deadline: '2026-02-31' } }, /must be a date/);
  bad('Person', { name: 'x', fields: { birthday: 'May 1' } }, /must be a date/);
  bad('Person', { name: 'x', fields: { keep_in_touch_days: 'x' } }, /whole number/);
  bad('Person', { name: 'x', fields: { email: 5 } }, /must be text/);
  bad('Company', { name: 'x' }, /Unsupported record type/);
  bad('constructor', { name: 'x' }, /Unsupported record type/);
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) bad('Person', { name: 'x', fields: JSON.parse(`{"${key}": "v"}`) }, /not a field/);
  assert.equal(validateRecord('Person', { name: 'x', fields: { keep_in_touch_days: '30' } }).fields.keep_in_touch_days, 30);
  assert.equal(validateRecord('Project', { fields: { status: '' }, name: 'x' }).fields.status, '', 'empty clears');
  assert.equal(validateRecord('Project', { fields: { status: 'done' } }, { partial: true }).name, undefined, 'partial edits need no name');
});

test('creating a record writes a new file and never overwrites an existing one', (t) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-records-unit-'));
  t.after(() => fs.rmSync(vaultDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(vaultDir, 'people'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'people', 'alice-chen.md'), '---\nname: Mine\n---\nkeep me\n');

  const created = createVaultRecord('Person', { name: 'Alice Chen', fields: { email: 'alice@example.com' }, notes: 'Peanut allergy.' }, { vaultDir });
  assert.equal(created.path, 'people/alice-chen-2.md');
  assert.equal(fs.readFileSync(path.join(vaultDir, 'people', 'alice-chen.md'), 'utf8'), '---\nname: Mine\n---\nkeep me\n');
  assert.equal(fs.readFileSync(path.join(vaultDir, created.path), 'utf8'), '---\nname: Alice Chen\nemail: alice@example.com\n---\nPeanut allergy.\n');
  assert.equal((fs.statSync(path.join(vaultDir, created.path)).mode & 0o777), 0o600);
  assert.ok(created.entityId.startsWith('ent_vault_'));
});

test('the API creates a project that appears in memory, and invalid input writes nothing', async (t) => {
  const { vault, get, post } = await fixture(t);
  const bad = await post('/api/vault/records', { type: 'Project', name: 'Roof', fields: { status: 'someday' } });
  assert.equal(bad.status, 400);
  assert.equal(fs.existsSync(path.join(vault, 'projects', 'roof.md')), false);
  assert.equal((await post('/api/vault/records', { type: 'Commitment', name: 'x' })).status, 400, 'only people and projects');

  const res = await post('/api/vault/records', { type: 'Project', name: 'Replace roof', fields: { status: 'planned', deadline: '2026-12-31' }, notes: 'Get three quotes.' });
  assert.equal(res.status, 201);
  const { entity, path: file } = await res.json();
  assert.equal(file, 'projects/replace-roof.md');
  assert.equal(entity.type, 'Project');
  assert.equal(entity.name, 'Replace roof');
  const detail = await (await get(`/api/memory/entities/${entity.id}`)).json();
  const facts = Object.fromEntries(detail.facts.map((f) => [f.key, f.value]));
  assert.equal(facts.status, 'planned');
  assert.equal(facts.deadline, '2026-12-31');
  assert.equal(facts.notes, 'Get three quotes.');
});

test('editing changes only the supplied fields and keeps the owner\'s comments and extra keys', async (t) => {
  const { vault, post, patch, get } = await fixture(t);
  const file = path.join(vault, 'people', 'bob.md');
  fs.writeFileSync(file, '---\n# my note about Bob\nname: Bob\nemail: bob@example.com\nphone: "555"\nclassification: private\nfavorite_color: green\n---\nLikes tea.\n');
  await post('/api/vault/reindex', {});
  const { entities } = await (await get('/api/memory/entities?type=Person&query=Bob')).json();
  const id = entities.find((e) => e.name === 'Bob').id;

  const res = await patch(`/api/vault/records/${id}`, { fields: { relationship: 'neighbor', phone: '' }, notes: 'Likes coffee.' });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# my note about Bob/);
  assert.match(text, /classification: private/);
  assert.match(text, /favorite_color: green/);
  assert.match(text, /relationship: neighbor/);
  assert.doesNotMatch(text, /phone/);
  assert.match(text, /Likes coffee\./);
  assert.doesNotMatch(text, /Likes tea/);

  assert.equal((await patch(`/api/vault/records/${id}`, { fields: { classification: 'public' } })).status, 400, 'privacy is not editable here');
  assert.equal((await patch(`/api/vault/records/${id}`, { name: '   ' })).status, 400);
  assert.equal((await patch('/api/vault/records/ent_missing', { notes: 'x' })).status, 404);
});

test('a database-only record is refused with an explanation, and invalid files are never rewritten', async (t) => {
  const { vault, patch, get, base } = await fixture(t);
  const { entities } = await (await get('/api/memory/entities?type=Person&query=Sarah')).json();
  const sarah = entities.find((e) => e.name.includes('Sarah'));
  const res = await patch(`/api/vault/records/${sarah.id}`, { notes: 'x' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'NOT_VAULT_BACKED');

  const file = path.join(vault, 'people', 'carol.md');
  fs.writeFileSync(file, '---\nname: Carol\n---\nhello\n');
  const reindex = await fetch(`${base}/api/vault/reindex`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(reindex.status, 200);
  const carol = (await (await get('/api/memory/entities?type=Person&query=Carol')).json()).entities[0];
  const corrupted = '---\nname: [unclosed\n---\nhello\n';
  fs.writeFileSync(file, corrupted);
  const refused = await patch(`/api/vault/records/${carol.id}`, { notes: 'changed' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /invalid frontmatter/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupted, 'an invalid file is left exactly as it was');
});

test('the edit dialog reads what the file says, and reports database-only records', async (t) => {
  const { vault, get, post } = await fixture(t);
  fs.writeFileSync(path.join(vault, 'projects', 'garden.md'), '---\nname: Garden\nstatus: blocked\ndeadline: 2026-09-01\nowner_note: keep\n---\nWaiting on soil.\n');
  await post('/api/vault/reindex', {});
  const garden = (await (await get('/api/memory/entities?type=Project&query=Garden')).json()).entities[0];
  const body = await (await get(`/api/vault/records/${garden.id}`)).json();
  assert.equal(body.vaultBacked, true);
  assert.deepEqual(body.fields, { status: 'blocked', deadline: '2026-09-01' }, 'only editable fields, as plain strings');
  assert.equal(body.notes, 'Waiting on soil.');

  const sarah = (await (await get('/api/memory/entities?type=Person&query=Sarah')).json()).entities[0];
  assert.equal((await (await get(`/api/vault/records/${sarah.id}`)).json()).vaultBacked, false);
  assert.equal((await get('/api/vault/records/ent_missing')).status, 404);
});

test('the list returns people with their file values, without the owner or notes', async (t) => {
  const { vault, get, post } = await fixture(t);
  fs.writeFileSync(path.join(vault, 'people', 'dana.md'), '---\nname: Dana\nrelationship: sister\nlast_contact: 2026-09-01\nkeep_in_touch_days: 14\nsecret_extra: hidden\n---\nPrivate notes.\n');
  await post('/api/vault/reindex', {});
  const { records } = await (await get('/api/vault/records?type=Person')).json();
  const dana = records.find((r) => r.name === 'Dana');
  assert.deepEqual(dana.fields, { relationship: 'sister', last_contact: '2026-09-01', keep_in_touch_days: '14' });
  assert.equal(dana.vaultBacked, true);
  assert.doesNotMatch(JSON.stringify(records), /Private notes|hidden/);
  const owner = (await (await get('/api/owner/entity')).json()).entity;
  assert.ok(!records.some((r) => r.id === owner.id), 'the owner is not listed as a contact');
  assert.ok(records.some((r) => r.name.includes('Sarah') && r.vaultBacked === false), 'database-only people are listed and marked');
  assert.equal((await get('/api/vault/records?type=Company')).status, 400);
});
