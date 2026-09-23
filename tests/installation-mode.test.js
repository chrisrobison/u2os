import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { ensureInstallationMode, installationModePath } from '../server/seed/installation-mode.js';
import { createEntity } from '../server/memory/entity-store.js';

async function close(handle) { await new Promise((resolve) => handle.server.close(resolve)); closeAllForTests(); }
function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-mode-')); }

test('personal startup stays free of demo records and setup creates only the owner entity', async () => {
  const dir = tempHome(); process.env.U2OS_HOME = dir; let handle;
  try {
    handle = await startServer({ port: 0 });
    assert.equal(JSON.parse(fs.readFileSync(installationModePath(dir))).mode, 'personal');
    for (const table of ['entities', 'emails', 'calendar_events', 'tasks', 'triggers']) {
      assert.equal(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    await handle.auth.setup('test-only owner passphrase');
    const entities = getDb().prepare('SELECT type, name FROM entities').all();
    assert.deepEqual(entities.map(({ type, name }) => ({ type, name })), [{ type: 'Person', name: 'Owner' }]);
    await close(handle); handle = await startServer({ port: 0 });
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM entities').get().count, 1);
  } finally { if (handle) await close(handle); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('demo mode is explicit, persistent, and cannot take over a personal home', async () => {
  const dir = tempHome(); process.env.U2OS_HOME = dir; let handle;
  try {
    handle = await startServer({ port: 0, mode: 'demo' });
    const count = getDb().prepare('SELECT COUNT(*) AS count FROM entities').get().count;
    assert.ok(count > 1);
    const setup = await fetch(`http://127.0.0.1:${handle.port}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    assert.equal(setup.status, 201);
    const linkedId = handle.auth.ownerEntity().id;
    assert.equal(handle.agent.ownerEntityId, linkedId);
    assert.equal(getDb().prepare('SELECT name FROM entities WHERE id = ?').get(linkedId).name, 'Chris');
    await close(handle); handle = await startServer({ port: 0 });
    assert.equal(JSON.parse(fs.readFileSync(installationModePath(dir))).mode, 'demo');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM entities').get().count, count);
    assert.equal(handle.auth.ownerEntity().id, linkedId);
    await assert.rejects(startServer({ port: 0, mode: 'personal' }), /already demo/);
  } finally { if (handle) await close(handle); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }

  const personalDir = tempHome(); process.env.U2OS_HOME = personalDir;
  try {
    handle = await startServer({ port: 0 }); await close(handle); handle = null;
    await assert.rejects(startServer({ port: 0, mode: 'demo' }), /already personal/);
  } finally { if (handle) await close(handle); delete process.env.U2OS_HOME; fs.rmSync(personalDir, { recursive: true, force: true }); }
});

test('unmarked legacy data is preserved and never converted into demo data', async () => {
  const dir = tempHome(); process.env.U2OS_HOME = dir; let handle;
  try {
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'legacy.json'), '{"user":"real"}');
    const real = createEntity({ type: 'Person', name: 'Actual contact' });
    assert.throws(() => ensureInstallationMode('demo', dir), /existing unmarked/);
    handle = await startServer({ port: 0 });
    assert.equal(JSON.parse(fs.readFileSync(installationModePath(dir))).mode, 'personal');
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'legacy.json'), 'utf8'), '{"user":"real"}');
    assert.deepEqual(getDb().prepare('SELECT id, name FROM entities').all().map(({ id, name }) => ({ id, name })), [{ id: real.id, name: 'Actual contact' }]);
  } finally { if (handle) await close(handle); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});
