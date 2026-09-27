import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, getFacts } from '../server/memory/fact-store.js';
import { proposeMemoryCandidate } from '../server/memory/candidate-store.js';
import { vaultEntityId } from '../server/vault/indexer.js';
import { parseMarkdown } from '../server/vault/markdown.js';
import { editVaultFile, applyClassification } from '../server/vault/writeback.js';
import { startServer } from './helpers/authed-server.js';

async function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-writeback-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const vault = process.env.U2OS_VAULT;
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
    fs.writeFileSync(path.join(vault, relative), text);
  }
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const read = (relative) => fs.readFileSync(path.join(vault, relative), 'utf8');
  const fact = (entityId, key) => getFacts(entityId).find((item) => item.key === key);
  return { vault, call, read, fact };
}

const ALICE = `---
# how I know her
name: Alice Chen
email: alice@example.com   # personal address
relationship: sister
---
Allergic to peanuts.
`;

test('correcting a vault fact edits only that line and keeps the file the authority', async (t) => {
  const { call, read, fact } = await fixture(t, { 'people/alice.md': ALICE });
  const alice = vaultEntityId('people/alice.md');
  const response = await call('PATCH', `/api/memory/facts/${fact(alice, 'email').id}`, { value: 'alice@new.example.com' });
  assert.equal(response.status, 200);
  assert.equal(response.body.vault.path, 'people/alice.md');
  assert.equal(response.body.fact.source, 'vault:people/alice.md');
  assert.equal(response.body.fact.value, 'alice@new.example.com');
  const text = read('people/alice.md');
  assert.match(text, /^# how I know her$/m, 'comments elsewhere are preserved');
  assert.match(text, /^email: alice@new\.example\.com$/m);
  assert.match(text, /^relationship: sister$/m);
  assert.match(text, /Allergic to peanuts\.\n$/);
  assert.equal(getFacts(alice).filter((item) => item.key === 'email').length, 1, 'one current value, no dispute');

  const renamed = await call('PATCH', `/api/memory/facts/${fact(alice, 'relationship').id}`, { key: 'relation', value: 'older sister' });
  assert.equal(renamed.status, 200);
  const renamedText = read('people/alice.md');
  assert.doesNotMatch(renamedText, /^relationship:/m);
  assert.match(renamedText, /^relation: older sister$/m);

  const notes = await call('PATCH', `/api/memory/facts/${fact(alice, 'notes').id}`, { value: 'Allergic to peanuts and shellfish.' });
  assert.equal(notes.status, 200);
  assert.match(read('people/alice.md'), /---\nAllergic to peanuts and shellfish\.\n$/);
});

test('reclassification records exactly the level the owner chose', async (t) => {
  const { call, read, fact } = await fixture(t, { 'people/bob.md': '---\nclassification: private\nphone: "555"\nemail: bob@example.com\n---\nNotes.\n' });
  const bob = vaultEntityId('people/bob.md');
  const lowered = await call('PATCH', `/api/memory/facts/${fact(bob, 'email').id}`, { classification: 'public' });
  assert.equal(lowered.status, 200);
  assert.equal(lowered.body.fact.classification, 'public', "the owner's explicit choice");
  const raised = await call('PATCH', `/api/memory/facts/${fact(bob, 'phone').id}`, { classification: 'sensitive' });
  assert.equal(raised.body.fact.classification, 'sensitive');
  const notes = await call('PATCH', `/api/memory/facts/${fact(bob, 'notes').id}`, { classification: 'sensitive' });
  assert.equal(notes.body.fact.classification, 'sensitive');
  const frontmatter = parseMarkdown(read('people/bob.md')).frontmatter;
  assert.deepEqual(frontmatter.sensitive_keys, ['phone', 'notes']);
  assert.deepEqual(frontmatter.classifications, { email: 'public' });
  const back = await call('PATCH', `/api/memory/facts/${fact(bob, 'email').id}`, { classification: 'private' });
  assert.equal(back.body.fact.classification, 'private');
  assert.equal(parseMarkdown(read('people/bob.md')).frontmatter.classifications, undefined, 'matching the file level needs no entry');
  assert.equal((await call('POST', '/api/vault/reindex')).body.report.changed, 0);
});

test('deleting a vault fact removes it from the file', async (t) => {
  const { call, read, fact } = await fixture(t, { 'people/alice.md': ALICE });
  const alice = vaultEntityId('people/alice.md');
  const response = await call('DELETE', `/api/memory/facts/${fact(alice, 'email').id}`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(read('people/alice.md'), /email:/);
  assert.equal(fact(alice, 'email'), undefined);
  assert.equal((await call('POST', '/api/vault/reindex')).body.report.changed, 0, 'the file and the index agree');
});

test('an accepted memory suggestion is written into the file', async (t) => {
  const { call, read, fact } = await fixture(t, { 'people/alice.md': ALICE });
  const alice = vaultEntityId('people/alice.md');
  const candidate = proposeMemoryCandidate({ content: 'prefers texts to calls' });
  const response = await call('POST', `/api/memory/candidates/${candidate.id}/accept`, { entityId: alice, key: 'contact_preference' });
  assert.equal(response.status, 200);
  assert.equal(response.body.fact.source, 'vault:people/alice.md');
  assert.ok(response.body.fact.supersedes_fact_id, 'the file-backed fact links to the accepted suggestion');
  assert.match(read('people/alice.md'), /^contact_preference: prefers texts to calls$/m);
  assert.equal(fact(alice, 'contact_preference').value, 'prefers texts to calls');

  const reserved = proposeMemoryCandidate({ content: 'x' });
  assert.equal((await call('POST', `/api/memory/candidates/${reserved.id}/accept`, { entityId: alice, key: 'id' })).status, 422);
});

test('owner facts go to me.md, and records outside the vault stay database-only', async (t) => {
  const { vault, call, read, fact } = await fixture(t);
  const owner = (await call('GET', '/api/owner/entity')).body.entity;
  const home = recordFact({ entityId: owner.id, key: 'home_city', value: 'Oakland', source: 'owner' });
  const response = await call('PATCH', `/api/memory/facts/${home.id}`, { value: 'San Francisco' });
  assert.equal(response.status, 200);
  assert.equal(response.body.vault.path, 'me.md');
  assert.equal(parseMarkdown(read('me.md')).frontmatter.home_city, 'San Francisco');
  assert.equal(fact(owner.id, 'home_city').source, 'vault:me.md');

  const outsider = createEntity({ type: 'Person', name: 'Carol' });
  const note = recordFact({ entityId: outsider.id, key: 'email', value: 'c@example.com', source: 'owner' });
  const outside = await call('PATCH', `/api/memory/facts/${note.id}`, { value: 'carol@example.com' });
  assert.equal(outside.status, 200);
  assert.equal(outside.body.vault, undefined);
  assert.deepEqual(fs.readdirSync(path.join(vault, 'people')), [], 'no file is invented for database-only records');
});

test('deleting a vault-backed record moves its file to .trash instead of letting it return', async (t) => {
  const { vault, call } = await fixture(t, { 'people/alice.md': ALICE });
  const alice = vaultEntityId('people/alice.md');
  const preview = (await call('GET', `/api/memory/entities/${alice}/deletion-preview`)).body;
  const response = await call('DELETE', `/api/memory/entities/${alice}`, { previewToken: preview.token });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(vault, 'people', 'alice.md')), false);
  assert.equal(fs.readdirSync(path.join(vault, '.trash')).length, 1, 'recoverable');
  await call('POST', '/api/vault/reindex');
  assert.equal((await call('GET', `/api/memory/entities/${alice}`)).status, 404, 'the record does not come back');
});

test('a relationship that comes from a vault file must be changed in the file', async (t) => {
  const { call } = await fixture(t, { 'commitments/report.md': '---\ntitle: Send the report\n---\n' });
  const commitment = vaultEntityId('commitments/report.md');
  await call('POST', '/api/vault/reindex'); // the owner link exists only after setup
  const relationship = (await call('GET', `/api/memory/entities/${commitment}`)).body.relationships.find((item) => item.source === 'vault:commitments/report.md');
  const response = await call('DELETE', `/api/memory/relationships/${relationship.id}`);
  assert.equal(response.status, 409);
  assert.match(response.body.error, /status: done/);
});

test('an edit is refused if the file changed underneath it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-writeback-race-'));
  try {
    fs.mkdirSync(path.join(dir, 'people'));
    const file = path.join(dir, 'people', 'x.md');
    fs.writeFileSync(file, '---\na: 1\n---\n');
    fs.chmodSync(file, 0o644);
    editVaultFile({ vaultDir: dir, relativePath: 'people/x.md' }, (frontmatter, body) => ({ frontmatter: { ...frontmatter, b: 2 }, body }));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, "the owner's file mode is kept");
    fs.writeFileSync(file, '---\na: 1\n---\n');
    assert.throws(() => editVaultFile({ vaultDir: dir, relativePath: 'people/x.md' }, (frontmatter, body) => {
      fs.writeFileSync(file, '---\na: 2\n---\n'); // the owner saved in their editor meanwhile
      return { frontmatter: { ...frontmatter, a: 3 }, body };
    }), (error) => error.status === 409);
    assert.equal(fs.readFileSync(file, 'utf8'), '---\na: 2\n---\n', "the owner's save wins");
    assert.deepEqual(fs.readdirSync(path.join(dir, 'people')), ['x.md'], 'no temporary files remain');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('classification is written exactly as chosen', () => {
  const fm = { classification: 'personal' };
  assert.equal(applyClassification(fm, 'ssn', 'sensitive'), 'sensitive');
  assert.deepEqual(fm.sensitive_keys, ['ssn']);
  assert.equal(applyClassification(fm, 'ssn', 'private'), 'private');
  assert.deepEqual(fm.sensitive_keys, []);
  assert.deepEqual(fm.classifications, { ssn: 'private' });
  assert.equal(applyClassification(fm, 'ssn', 'personal'), 'personal');
  assert.deepEqual(fm.classifications, {});
  assert.throws(() => applyClassification(fm, 'x', 'secret'), (error) => error.status === 400);
});
