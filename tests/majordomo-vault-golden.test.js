import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { indexVault } from '../server/vault/indexer.js';
import { getVaultDir } from '../server/vault/vault-dir.js';

// Shared golden for the Rust vault reader (majordomo/, ADR 0011). Node indexes
// the fixture vault; the result must equal majordomo/tests/fixtures/vault-expected.json,
// which the Rust test also asserts. Regenerate on purpose with:
//   UPDATE_MAJORDOMO_GOLDEN=1 node --test tests/majordomo-vault-golden.test.js

const FIXTURE = path.join(import.meta.dirname, '..', 'majordomo', 'tests', 'fixtures', 'vault');
const GOLDEN = path.join(import.meta.dirname, '..', 'majordomo', 'tests', 'fixtures', 'vault-expected.json');

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]));
  return value;
}

test('Node indexer output for the fixture vault matches the shared golden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-golden-'));
  process.env.U2OS_HOME = dir;
  try {
    const db = getDb();
    const ownerEntityId = createEntity({ type: 'Person', name: 'Owner' }).id;
    db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('owner_1', ?, 'x', 'x', '{}', ?)").run(ownerEntityId, new Date().toISOString());
    const now = new Date().toISOString();
    db.prepare("INSERT INTO entities (id, type, name, attributes, status, created_at, updated_at) VALUES ('ent_known_dave','Person','Dave','{}','active',?,?)").run(now, now);

    fs.cpSync(FIXTURE, getVaultDir(), { recursive: true });
    const report = indexVault();

    const records = [];
    const entities = db.prepare("SELECT * FROM entities WHERE json_extract(attributes, '$.vaultPath') IS NOT NULL AND status != 'deleted'").all();
    const owner = db.prepare('SELECT * FROM entities WHERE id = ?').get(ownerEntityId);
    for (const entity of [...entities, { ...owner, attributes: JSON.stringify({ vaultPath: 'me.md' }) }]) {
      const attributes = JSON.parse(entity.attributes);
      const rel = attributes.vaultPath;
      const facts = {};
      for (const f of db.prepare("SELECT key, value, classification FROM facts WHERE entity_id = ? AND source = ? AND status = 'current'").all(entity.id, `vault:${rel}`)) {
        facts[f.key] = { value: JSON.parse(f.value), classification: f.classification };
      }
      const isOwner = rel === 'me.md';
      const record = { path: rel, type: 'Person', facts };
      if (!isOwner) {
        Object.assign(record, {
          type: entity.type, name: entity.name, classification: entity.classification,
          id: entity.id,
        });
        if (entity.type === 'Commitment') record.status = attributes.status;
      }
      records.push(record);
    }
    records.sort((a, b) => (a.path < b.path ? -1 : 1));
    const actual = sortDeep({ records, invalid: report.errors.map((e) => e.path).sort() });

    if (process.env.UPDATE_MAJORDOMO_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  } finally {
    closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
  }
});
