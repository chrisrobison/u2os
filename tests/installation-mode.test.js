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
    const demoStatus = await fetch(`http://127.0.0.1:${handle.port}/api/model`, { headers: { cookie: setup.headers.get('set-cookie').split(';')[0] } });
    assert.equal((await demoStatus.json()).plannerStatus, 'demo');
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

test('personal mode exposes planner configuration gap and cannot run the canned planner', async () => {
  const dir = tempHome(); process.env.U2OS_HOME = dir; let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.port}`;
    const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const csrf = (await setup.json()).csrfToken;
    const headers = { cookie, origin, 'x-u2os-csrf': csrf, 'content-type': 'application/json' };
    assert.equal((await (await fetch(`${origin}/api/model`, { headers })).json()).plannerStatus, 'configuration-required');
    const plan = await fetch(`${origin}/api/agent/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'Send a reply' }) });
    assert.equal(plan.status, 503);
    assert.match((await plan.json()).error, /configure a local or remote model/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM agent_actions').get().count, 0);
    const rejectedMock = await fetch(`${origin}/api/model`, { method: 'POST', headers, body: JSON.stringify({ provider: 'mock' }) });
    assert.equal(rejectedMock.status, 400);
    const rejectedMultiMock = await fetch(`${origin}/api/model`, { method: 'POST', headers, body: JSON.stringify({ providers: { fixture: { type: 'mock' } }, roles: { planner: 'fixture' } }) });
    assert.equal(rejectedMultiMock.status, 400);
    const rejectedEmbeddingPlanner = await fetch(`${origin}/api/model`, { method: 'POST', headers, body: JSON.stringify({ providers: { embed: { type: 'embedding-openai-compatible', baseUrl: 'http://127.0.0.1:1234', model: 'fixture' } }, roles: { planner: 'embed' } }) });
    assert.equal(rejectedEmbeddingPlanner.status, 400);
    const configured = await fetch(`${origin}/api/model`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', model: 'fixture' }) });
    assert.equal(configured.status, 200);
    await close(handle); handle = await startServer({ port: 0 });
    const session = handle.auth.createSession('owner');
    assert.equal((await (await fetch(`http://127.0.0.1:${handle.port}/api/model`, { headers: { cookie: `u2os_session=${session.token}` } })).json()).plannerStatus, 'configured');
  } finally { if (handle) await close(handle); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});
