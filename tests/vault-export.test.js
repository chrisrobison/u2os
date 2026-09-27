import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, getFacts } from '../server/memory/fact-store.js';
import { recordRelationship } from '../server/memory/relationship-store.js';
import { selectMemoryCandidates } from '../server/memory/candidate-retrieval.js';
import { indexVault } from '../server/vault/indexer.js';
import { exportMemoryToVault } from '../server/vault/exporter.js';
import { parseMarkdown } from '../server/vault/markdown.js';
import { getVaultDir } from '../server/vault/vault-dir.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-vault-export-'));
  process.env.U2OS_HOME = dir;
  const db = getDb();
  const owner = createEntity({ type: 'Person', name: 'Chris' });
  db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('owner_1', ?, 'x', 'x', '{}', ?)").run(owner.id, new Date().toISOString());
  const vault = getVaultDir();
  const read = (relative) => parseMarkdown(fs.readFileSync(path.join(vault, relative), 'utf8'));
  return { dir, db, vault, read, ownerEntityId: owner.id };
}

function cleanup(dir) {
  closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
}

const current = (entityId) => Object.fromEntries(getFacts(entityId).map((fact) => [fact.key, fact.value]));

test('database memory is exported to vault files bound to the same records', () => {
  const { dir, db, read, ownerEntityId } = fixture();
  try {
    recordFact({ entityId: ownerEntityId, key: 'home_city', value: 'San Francisco', source: 'owner' });
    const alice = createEntity({ type: 'Person', name: 'Alice Chen' });
    recordFact({ entityId: alice.id, key: 'email', value: 'alice@example.com', source: 'google-contacts' });
    recordFact({ entityId: alice.id, key: 'birthday', value: '1990-05-01', source: 'owner' });
    recordFact({ entityId: alice.id, key: 'notes', value: 'Allergic to peanuts.', source: 'owner' });
    recordFact({ entityId: alice.id, key: 'mood', value: 'cheerful', source: 'agent:inference', inferred: true, confidence: 0.5 });
    const project = createEntity({ type: 'Project', name: 'House renovation' });
    const promise = createEntity({ type: 'Commitment', name: 'send the report', attributes: { description: 'send the report', status: 'open' } });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: promise.id, source: 'system:projector', inferred: true, confidence: 0.8 });

    const report = exportMemoryToVault();
    assert.deepEqual(report.written.sort(), ['commitments/send-the-report.md', 'me.md', 'people/alice-chen.md', 'projects/house-renovation.md']);
    assert.equal(report.inferredFactsLeftOut, 1, 'guesses are not promoted to owner-authored files');

    const file = read('people/alice-chen.md');
    assert.equal(file.frontmatter.id, alice.id);
    assert.equal(file.frontmatter.birthday, '1990-05-01');
    assert.equal(file.body, 'Allergic to peanuts.');
    assert.equal(read('me.md').frontmatter.home_city, 'San Francisco');
    assert.equal(read('me.md').frontmatter.id, undefined, 'the owner is always me.md');

    const entitiesBefore = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
    const index = indexVault();
    assert.deepEqual(index.errors, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, entitiesBefore, 'no duplicate records');
    assert.deepEqual(current(alice.id), { email: 'alice@example.com', birthday: '1990-05-01', notes: 'Allergic to peanuts.', mood: 'cheerful' });
    assert.ok(getFacts(alice.id).filter((fact) => fact.key !== 'mood').every((fact) => fact.source === 'vault:people/alice-chen.md'), 'the file is now the authority');
    assert.equal(JSON.parse(db.prepare('SELECT attributes FROM entities WHERE id = ?').get(project.id).attributes).vaultPath, 'projects/house-renovation.md');
    assert.equal(selectMemoryCandidates({ ownerEntityId }).commitments.length, 1, 'an exported commitment is not listed twice');

    const second = exportMemoryToVault();
    assert.deepEqual(second.written, [], 'records already in the vault are not exported again');
    assert.equal(indexVault().changed, 0);
  } finally { cleanup(dir); }
});

test('export never overwrites files or lowers privacy', () => {
  const { dir, vault, read } = fixture();
  try {
    fs.mkdirSync(path.join(vault, 'people'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'me.md'), '---\nname: Mine\n---\nHand written.\n');
    fs.writeFileSync(path.join(vault, 'people', 'bob.md'), '---\nname: Someone else\n---\n');
    const bob = createEntity({ type: 'Person', name: 'Bob' });
    recordFact({ entityId: bob.id, key: 'email', value: 'bob@example.com', source: 'owner', classification: 'private' });
    recordFact({ entityId: bob.id, key: 'ssn', value: '123', source: 'owner', classification: 'sensitive' });
    recordFact({ entityId: bob.id, key: 'notes', value: 'diagnosis details', source: 'owner', classification: 'sensitive' });

    const report = exportMemoryToVault();
    assert.deepEqual(report.skippedExisting, ['me.md']);
    assert.equal(fs.readFileSync(path.join(vault, 'me.md'), 'utf8'), '---\nname: Mine\n---\nHand written.\n');
    assert.ok(report.written.includes('people/bob-2.md'), 'a name collision picks a new file name');
    const file = read('people/bob-2.md');
    assert.equal(file.frontmatter.classification, 'personal', 'the file carries the record level');
    assert.deepEqual(file.frontmatter.sensitive_keys, ['ssn', 'notes']);
    assert.deepEqual(file.frontmatter.classifications, { email: 'private' });
    assert.equal(file.body, 'diagnosis details');

    indexVault();
    const levels = Object.fromEntries(getFacts(bob.id).map((fact) => [fact.key, fact.classification]));
    assert.equal(levels.email, 'private');
    assert.equal(levels.ssn, 'sensitive');
    assert.equal(levels.notes, 'sensitive', 'every level survives the round trip exactly');
    assert.equal(getFacts(bob.id).find((fact) => fact.key === 'notes').source, 'vault:people/bob-2.md');
  } finally { cleanup(dir); }
});

test('an id must name a known, unclaimed, non-owner record', () => {
  const { dir, vault, ownerEntityId } = fixture();
  try {
    const carol = createEntity({ type: 'Person', name: 'Carol' });
    fs.mkdirSync(path.join(vault, 'people'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'people', 'a.md'), `---\nid: ${carol.id}\nemail: a@example.com\n---\n`);
    fs.writeFileSync(path.join(vault, 'people', 'b.md'), `---\nid: ${carol.id}\n---\n`);
    fs.writeFileSync(path.join(vault, 'people', 'c.md'), '---\nid: ent_missing\n---\n');
    fs.writeFileSync(path.join(vault, 'people', 'd.md'), `---\nid: ${ownerEntityId}\n---\n`);
    fs.writeFileSync(path.join(vault, 'people', 'e.md'), '---\nid: "not an id"\n---\n');
    const report = indexVault();
    assert.deepEqual(report.errors.map((error) => error.path), ['people/b.md', 'people/c.md', 'people/d.md', 'people/e.md']);
    assert.equal(current(carol.id).email, 'a@example.com');
  } finally { cleanup(dir); }
});

test('renaming or removing a bound file keeps the record and what other sources know', () => {
  const { dir, db, vault } = fixture();
  try {
    const dana = createEntity({ type: 'Person', name: 'Dana', attributes: { source: 'contacts' } });
    recordFact({ entityId: dana.id, key: 'phone', value: '555', source: 'google-contacts' });
    fs.mkdirSync(path.join(vault, 'people'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'people', 'dana.md'), `---\nid: ${dana.id}\nemail: d@example.com\nteam: blue\n---\n`);
    indexVault();
    assert.equal(JSON.parse(db.prepare('SELECT attributes FROM entities WHERE id = ?').get(dana.id).attributes).source, 'contacts', 'other attributes are kept');

    fs.renameSync(path.join(vault, 'people', 'dana.md'), path.join(vault, 'people', 'dana-kim.md'));
    fs.writeFileSync(path.join(vault, 'people', 'dana-kim.md'), `---\nid: ${dana.id}\nemail: d@example.com\n---\n`);
    indexVault();
    assert.deepEqual(current(dana.id), { phone: '555', email: 'd@example.com' }, 'the renamed file replaces what the old file said');

    fs.rmSync(path.join(vault, 'people', 'dana-kim.md'));
    assert.equal(indexVault().removed, 1);
    const row = db.prepare('SELECT status, attributes FROM entities WHERE id = ?').get(dana.id);
    assert.equal(row.status, 'active', 'a described record is not deleted with its file');
    assert.equal(JSON.parse(row.attributes).vaultPath, undefined);
    assert.deepEqual(current(dana.id), { phone: '555' });
  } finally { cleanup(dir); }
});
