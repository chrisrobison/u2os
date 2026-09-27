import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, getFacts, classifyFactOrigin } from '../server/memory/fact-store.js';
import { selectMemoryCandidates } from '../server/memory/candidate-retrieval.js';
import { indexVault, vaultEntityId } from '../server/vault/indexer.js';
import { parseMarkdown } from '../server/vault/markdown.js';
import { getVaultDir } from '../server/vault/vault-dir.js';
import { startServer } from './helpers/authed-server.js';

function fixture({ owner = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-'));
  process.env.U2OS_HOME = dir;
  const db = getDb();
  let ownerEntityId = null;
  if (owner) {
    ownerEntityId = createEntity({ type: 'Person', name: 'Owner' }).id;
    db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('owner_1', ?, 'x', 'x', '{}', ?)").run(ownerEntityId, new Date().toISOString());
  }
  const vault = getVaultDir();
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true }); fs.writeFileSync(path.join(vault, relative), text); };
  return { dir, db, vault, write, ownerEntityId, eventBus: new EventBus(db) };
}

function cleanup(dir) {
  closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
}

const facts = (entityId) => Object.fromEntries(getFacts(entityId).map((fact) => [fact.key, fact.value]));

test('frontmatter is parsed with plain JSON types and dates stay strings', () => {
  const { frontmatter, body } = parseMarkdown('---\nname: Alice\nbirthday: 1990-05-01\ntags: [a, b]\n---\n# Alice\nLikes tea.\n');
  assert.deepEqual(frontmatter, { name: 'Alice', birthday: '1990-05-01', tags: ['a', 'b'] });
  assert.equal(body, '# Alice\nLikes tea.');
  assert.deepEqual(parseMarkdown('Just notes.'), { frontmatter: {}, body: 'Just notes.' });
  assert.throws(() => parseMarkdown('---\nname: [unclosed\n---\n'), /Invalid YAML/);
});

test('people, projects, commitments and me.md become explicit vault-sourced memory', () => {
  const { dir, db, write, ownerEntityId } = fixture();
  try {
    write('me.md', '---\nname: Chris\nhome_city: San Francisco\n---\nI prefer mornings for deep work.\n');
    write('people/alice-chen.md', '---\nname: Alice Chen\nemail: alice@example.com\nrelationship: sister\n---\nAllergic to peanuts.\n');
    write('projects/house.md', '# House renovation\nKitchen first.\n');
    write('commitments/send-report.md', '---\ntitle: Send Q3 report to Dana\ndue: 2026-10-01\n---\n');

    const report = indexVault();
    assert.equal(report.files, 4);
    assert.equal(report.changed, 4);
    assert.deepEqual(report.errors, []);

    assert.deepEqual(facts(ownerEntityId), { name: 'Chris', home_city: 'San Francisco', notes: 'I prefer mornings for deep work.' });
    const alice = db.prepare('SELECT * FROM entities WHERE id = ?').get(vaultEntityId('people/alice-chen.md'));
    assert.equal(alice.type, 'Person');
    assert.equal(alice.name, 'Alice Chen');
    assert.deepEqual(facts(alice.id), { email: 'alice@example.com', relationship: 'sister', notes: 'Allergic to peanuts.' });
    const aliceFact = getFacts(alice.id).find((fact) => fact.key === 'email');
    assert.equal(aliceFact.source, 'vault:people/alice-chen.md');
    assert.equal(classifyFactOrigin(aliceFact), 'explicit');

    const project = db.prepare('SELECT * FROM entities WHERE id = ?').get(vaultEntityId('projects/house.md'));
    assert.equal(project.type, 'Project');
    assert.equal(project.name, 'House renovation');

    const commitments = selectMemoryCandidates({ ownerEntityId }).commitments;
    assert.equal(commitments.length, 1);
    assert.equal(commitments[0].name, 'Send Q3 report to Dana');
  } finally { cleanup(dir); }
});

test('re-indexing an unchanged vault writes nothing', () => {
  const { dir, db, write, eventBus } = fixture();
  try {
    write('people/bob.md', '---\nemail: bob@example.com\n---\nNotes.\n');
    indexVault({ eventBus });
    const before = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'vault.indexed'").get().n;
    const report = indexVault({ eventBus });
    assert.equal(report.changed, 0);
    assert.equal(report.unchanged, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'vault.indexed'").get().n, events, 'no event without changes');
  } finally { cleanup(dir); }
});

test('edits supersede changed facts, removed keys and files are soft-deleted, other sources untouched', () => {
  const { dir, db, write, vault } = fixture();
  try {
    write('people/bob.md', '---\nemail: bob@example.com\nphone: "555"\n---\n');
    indexVault();
    const bobId = vaultEntityId('people/bob.md');
    const inferred = recordFact({ entityId: bobId, key: 'favorite_food', value: 'ramen', source: 'agent:inference', inferred: true, confidence: 0.6 });

    write('people/bob.md', '---\nemail: bob@new.example.com\n---\n');
    const report = indexVault();
    assert.equal(report.changed, 1);
    assert.deepEqual(facts(bobId), { email: 'bob@new.example.com', favorite_food: 'ramen' });
    const newEmail = getFacts(bobId).find((fact) => fact.key === 'email');
    assert.ok(newEmail.supersedes_fact_id, 'the new value links to the value it replaced');
    assert.equal(db.prepare('SELECT status FROM facts WHERE id = ?').get(newEmail.supersedes_fact_id).status, 'superseded');

    fs.rmSync(path.join(vault, 'people/bob.md'));
    assert.equal(indexVault().removed, 1);
    assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(bobId).status, 'deleted');
    assert.equal(db.prepare('SELECT status FROM facts WHERE id = ?').get(inferred.id).status, 'current', 'non-vault facts are never modified');
  } finally { cleanup(dir); }
});

test('a conflicting owner edit elsewhere stays disputed without duplicating on re-index', () => {
  const { dir, db, write } = fixture();
  try {
    write('people/eve.md', '---\nemail: eve@example.com\n---\n');
    indexVault();
    const eveId = vaultEntityId('people/eve.md');
    recordFact({ entityId: eveId, key: 'email', value: 'eve@other.example.com', source: 'owner' });
    indexVault();
    indexVault();
    const rows = db.prepare("SELECT source, status FROM facts WHERE entity_id = ? AND key = 'email' AND status != 'superseded' ORDER BY source").all(eveId).map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ source: 'owner', status: 'disputed' }, { source: 'vault:people/eve.md', status: 'disputed' }]);
  } finally { cleanup(dir); }
});

test('classification and sensitive_keys set privacy; invalid files are reported and skipped', () => {
  const { dir, write } = fixture();
  try {
    write('people/carol.md', '---\nclassification: private\nsensitive_keys: [ssn]\nssn: "123"\nemail: c@example.com\n---\n');
    write('people/bad-yaml.md', '---\nname: [oops\n---\n');
    write('people/bad-class.md', '---\nclassification: secret\n---\n');
    write('people/bad-map.md', '---\nclassifications:\n  email: secret\n---\n');
    write('people/dave.md', '---\nclassifications:\n  email: public\n  notes: private\nemail: d@example.com\nphone: "1"\n---\nPrivate note.\n');
    const report = indexVault();
    assert.equal(report.changed, 2);
    assert.deepEqual(report.errors.map((error) => error.path).sort(), ['people/bad-class.md', 'people/bad-map.md', 'people/bad-yaml.md']);
    const dave = Object.fromEntries(getFacts(vaultEntityId('people/dave.md')).map((fact) => [fact.key, fact.classification]));
    assert.deepEqual(dave, { email: 'public', phone: 'personal', notes: 'private' }, 'per-key levels apply exactly');
    const byKey = Object.fromEntries(getFacts(vaultEntityId('people/carol.md')).map((fact) => [fact.key, fact.classification]));
    assert.deepEqual(byKey, { ssn: 'sensitive', email: 'private' });
  } finally { cleanup(dir); }
});

test('symlinks, hidden files and oversized files are never read', () => {
  const { dir, write, vault } = fixture();
  try {
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, '---\nsecret: leaked\n---\n');
    fs.mkdirSync(path.join(vault, 'people'), { recursive: true });
    fs.symlinkSync(outside, path.join(vault, 'people', 'link.md'));
    write('people/.hidden.md', '---\nname: Hidden\n---\n');
    write('people/huge.md', `---\nname: Huge\n---\n${'x'.repeat(300 * 1024)}`);
    const report = indexVault();
    assert.equal(report.changed, 0);
    assert.deepEqual(report.errors.map((error) => error.path), ['people/huge.md']);
  } finally { cleanup(dir); }
});

test('me.md waits for an owner account instead of failing', () => {
  const { dir, write } = fixture({ owner: false });
  try {
    write('me.md', '---\nname: Chris\n---\n');
    const report = indexVault();
    assert.equal(report.changed, 0);
    assert.deepEqual(report.errors, []);
    assert.equal(report.notes.length, 1);
  } finally { cleanup(dir); }
});

test('the running server indexes the vault on start and exposes status to the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-server-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'my-digital-self');
  const vault = getVaultDir();
  assert.equal(vault, process.env.U2OS_VAULT, 'U2OS_VAULT places the vault anywhere the owner chooses');
  fs.mkdirSync(path.join(vault, 'people'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'people', 'dana.md'), '---\nemail: dana@example.com\n---\n');
  const handle = await startServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    assert.ok(fs.existsSync(path.join(vault, 'README.md')), 'default layout is created');
    const status = await (await fetch(`${base}/api/vault`)).json();
    assert.equal(status.vaultDir, vault);
    assert.equal(status.lastIndex.errors.length, 0);
    assert.deepEqual(facts(vaultEntityId('people/dana.md')), { email: 'dana@example.com' });

    fs.writeFileSync(path.join(vault, 'people', 'erin.md'), '---\nemail: erin@example.com\n---\n');
    const reindex = await (await fetch(`${base}/api/vault/reindex`, { method: 'POST' })).json();
    assert.equal(reindex.report.changed, 1);
    assert.equal((await nativeUnauthenticated(`${base}/api/vault`)).status, 401);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    delete process.env.U2OS_VAULT;
    cleanup(dir);
  }
});

function nativeUnauthenticated(url) {
  // A different origin key than the authenticated helper recognises.
  return fetch(url.replace('127.0.0.1', 'localhost'));
}
