import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, getFact, getFacts, getFactRevisions } from '../server/memory/fact-store.js';
import { startServer } from './helpers/authed-server.js';

test('fact lifecycle routes confirm, reclassify, correct, and soft-delete with audit history', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-fact-lifecycle-')); process.env.U2OS_HOME = home;
  let handle;
  try {
    handle = await startServer({ port: 0 }); const base = `http://127.0.0.1:${handle.port}`;
    const person = createEntity({ type: 'Person', name: 'Alex' });
    const original = recordFact({ entityId: person.id, key: 'meeting_preference', value: 'afternoons', source: 'owner', classification: 'personal' });

    let response = await fetch(`${base}/api/memory/facts/${original.id}/confirm`, { method: 'POST' });
    assert.equal(response.status, 200); assert.ok((await response.json()).fact.last_confirmed_at);
    response = await fetch(`${base}/api/memory/facts/${original.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classification: 'private' }) });
    assert.equal((await response.json()).fact.classification, 'private');
    response = await fetch(`${base}/api/memory/facts/${original.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'mornings' }) });
    const corrected = await response.json();
    assert.equal(corrected.previous.status, 'superseded'); assert.equal(corrected.fact.value, 'mornings'); assert.equal(corrected.fact.supersedes_fact_id, original.id);
    assert.deepEqual(getFacts(person.id).map((fact) => fact.id), [corrected.fact.id]);
    assert.equal(getFacts(person.id, { includeInactive: true }).length, 2);

    response = await fetch(`${base}/api/memory/facts/${corrected.fact.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200); assert.equal(getFact(corrected.fact.id).status, 'deleted'); assert.equal(getFacts(person.id).length, 0);
    assert.deepEqual(getFactRevisions(original.id).map((revision) => revision.operation), ['confirm', 'reclassify', 'correct']);
    const eventTypes = getDb().prepare("SELECT type FROM events WHERE type LIKE 'memory.fact_%' ORDER BY created_at").all().map((row) => row.type);
    assert.ok(eventTypes.includes('memory.fact_confirmed')); assert.ok(eventTypes.includes('memory.fact_reclassified')); assert.ok(eventTypes.includes('memory.fact_corrected')); assert.ok(eventTypes.includes('memory.fact_deleted'));
  } finally {
    if (handle) await new Promise((resolve) => handle.server.close(resolve)); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true });
  }
});

test('existing fact tables migrate additively without changing stored values', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-fact-migration-')); process.env.U2OS_HOME = home;
  try {
    const dbDir = path.join(home, 'db'); fs.mkdirSync(dbDir, { recursive: true });
    const { DatabaseSync } = requireSqlite(); const legacy = new DatabaseSync(path.join(dbDir, 'u2os.sqlite'));
    legacy.exec("CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, attributes TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE facts (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, inferred INTEGER NOT NULL DEFAULT 0, observed_at TEXT NOT NULL, last_confirmed_at TEXT, provenance TEXT NOT NULL DEFAULT '{}', classification TEXT NOT NULL DEFAULT 'personal', created_at TEXT NOT NULL);");
    legacy.prepare("INSERT INTO entities VALUES ('e1','Person','Legacy','{}','now','now')").run();
    legacy.prepare("INSERT INTO facts VALUES ('f1','e1','note','\"kept\"','legacy',1,0,'now',NULL,'{}','private','now')").run(); legacy.close();
    const fact = getFact('f1'); assert.equal(fact.value, 'kept'); assert.equal(fact.status, 'current'); assert.equal(fact.classification, 'private');
  } finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true }); }
});

function requireSqlite() {
  return process.getBuiltinModule('node:sqlite');
}

test('contradictory facts use deterministic authority and never reach context as equally current', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-fact-conflict-')); process.env.U2OS_HOME = home;
  try {
    const person = createEntity({ type: 'Person', name: 'Sam' });
    const inferred = recordFact({ entityId: person.id, key: 'meeting_time', value: 'afternoon', source: 'import', confidence: 0.7, inferred: true });
    const explicit = recordFact({ entityId: person.id, key: 'meeting_time', value: 'morning', source: 'owner', inferred: false });
    assert.equal(getFact(inferred.id).status, 'superseded'); assert.equal(explicit.status, 'current');
    const repeatedInference = recordFact({ entityId: person.id, key: 'meeting_time', value: 'morning', source: 'inference', inferred: true });
    assert.equal(repeatedInference.status, 'superseded'); assert.equal(getFact(explicit.id).status, 'current');
    const weakConflict = recordFact({ entityId: person.id, key: 'meeting_time', value: 'evening', source: 'inference', inferred: true });
    assert.equal(weakConflict.status, 'disputed'); assert.deepEqual(getFacts(person.id).map((fact) => fact.id), [explicit.id]);
    const explicitConflict = recordFact({ entityId: person.id, key: 'meeting_time', value: 'noon', source: 'trusted-import', inferred: false });
    assert.equal(explicitConflict.status, 'disputed'); assert.equal(getFact(explicit.id).status, 'disputed'); assert.equal(getFacts(person.id).length, 0);
    assert.equal(getFacts(person.id, { includeInactive: true }).filter((fact) => fact.status === 'disputed').length, 3);
  } finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true }); }
});
