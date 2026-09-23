import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { createEntity, updateEntity, getEntity, getEntityDeletionPreview, deleteEntity } from '../server/memory/entity-store.js';
import { recordRelationship } from '../server/memory/relationship-store.js';

const PASS = 'correct horse battery staple';
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-auth-')); process.env.U2OS_HOME = dir; return dir; }
async function stop(handle, dir) { if (handle) await new Promise((r) => handle.server.close(r)); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
function base(handle) { return `http://127.0.0.1:${handle.port}`; }
async function setup(handle) {
  const res = await fetch(`${base(handle)}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
  const body = await res.json(); return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
}
function opts(auth, extra = {}) { return { ...extra, headers: { ...(extra.headers || {}), cookie: auth.cookie, origin: auth.origin, 'x-u2os-csrf': auth.csrf } }; }

test('HTTP auth boundary, owner setup, CSRF, actor identity, limits, headers, and audit rejection', async () => {
  const dir = home(); let handle;
  try {
    handle = await startServer({ port: 0 }); const origin = base(handle);
    assert.equal(handle.server.address().address, '127.0.0.1');
    for (const route of ['/api/events', '/api/memory/entities', '/api/export', '/api/actions/pending']) assert.equal((await fetch(origin + route)).status, 401);
    for (const [route, body] of [['/api/actions/nope/approve', {}], ['/api/triggers', {}], ['/api/connectors/google/credentials', {}], ['/api/voice/enrollment', { vector: [1] }]]) {
      assert.equal((await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    }
    const health = await fetch(origin + '/api/health'); assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok'); assert.equal(health.headers.get('x-frame-options'), 'DENY');
    const auth = await setup(handle); auth.origin = origin;
    assert.ok(auth.cookie.startsWith('u2os_session='));
    assert.notEqual((await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) })).status, 201);
    const wrong = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'wrong passphrase value' }) });
    assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('set-cookie'), null);
    const noCsrf = await fetch(origin + '/api/actions/nope/approve', { method: 'POST', headers: { cookie: auth.cookie, origin }, body: '{}' }); assert.equal(noCsrf.status, 403);
    const proposed = await fetch(origin + '/api/agent/message', opts(auth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.', actorId: 'attacker' }) }));
    const action = (await proposed.json()).actions[0];
    const approved = await fetch(`${origin}/api/actions/${action.id}/approve`, opts(auth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'attacker' }) })); assert.equal(approved.status, 200);
    assert.equal(getDb().prepare('SELECT approved_by FROM agent_actions WHERE id=?').get(action.id).approved_by, 'owner');
    const proposed2 = await fetch(origin + '/api/agent/message', opts(auth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.' }) }));
    const action2 = (await proposed2.json()).actions[0];
    await fetch(`${origin}/api/actions/${action2.id}/reject`, opts(auth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const rejected = getDb().prepare('SELECT approved_by,rejected_by FROM agent_actions WHERE id=?').get(action2.id); assert.equal(rejected.approved_by, null); assert.equal(rejected.rejected_by, 'owner');
    const huge = await fetch(origin + '/api/agent/message', opts(auth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1048577) }) })); assert.equal(huge.status, 413);
  } finally { await stop(handle, dir); }
});

test('login throttling and expired sessions including SSE fail closed', async () => {
  const dir = home(); let handle;
  try {
    handle = await startServer({ port: 0, sessionIdleSeconds: 0.05 }); const origin = base(handle); await setup(handle);
    let last; for (let i = 0; i < 9; i++) last = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'incorrect passphrase' }) });
    assert.equal(last.status, 429);
    await new Promise((r) => setTimeout(r, 80));
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
    assert.equal(login.status, 429);
    const session = handle.auth.createSession('owner'); await new Promise((r) => setTimeout(r, 80));
    const cookie = `u2os_session=${session.token}`;
    assert.equal((await fetch(origin + '/api/events', { headers: { cookie } })).status, 401);
    assert.equal((await fetch(origin + '/api/events/stream', { headers: { cookie } })).status, 401);
  } finally { await stop(handle, dir); }
});

test('owner entity link survives renames and restart, supports explicit legacy relink, and protects deletion', async () => {
  const dir = home(); let handle;
  try {
    handle = await startServer({ port: 0 });
    assert.equal((await fetch(`${base(handle)}/api/owner/entity`)).status, 401);
    const auth = await setup(handle); auth.origin = base(handle);
    const initial = (await (await fetch(`${base(handle)}/api/owner/entity`, opts(auth))).json()).entity;
    assert.ok(initial.id);
    assert.equal(handle.agent.ownerEntityId, initial.id);
    const commitment = createEntity({ type: 'Commitment', name: 'Send research notes', attributes: { description: 'send research notes', status: 'open' } });
    recordRelationship({ fromEntityId: initial.id, relation: 'promised', toEntityId: commitment.id, source: 'test' });
    updateEntity(initial.id, { name: 'Renamed owner' });
    assert.equal(handle.agent.contextAssembler.ownerEntityId, initial.id);
    assert.ok((await handle.agent.contextAssembler.assemblePersonalContext('research notes')).commitments.some((item) => item.id === commitment.id));
    assert.equal((await (await fetch(`${base(handle)}/api/owner/entity`, opts(auth))).json()).entity.name, 'Renamed owner');
    const preview = getEntityDeletionPreview(initial.id);
    assert.throws(() => deleteEntity(initial.id, preview.token), { code: 'OWNER_ENTITY_PROTECTED' });

    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests();
    handle = await startServer({ port: 0 });
    assert.equal(handle.agent.ownerEntityId, initial.id);
    assert.ok((await handle.agent.contextAssembler.assemblePersonalContext('research notes')).commitments.some((item) => item.id === commitment.id));

    // A legacy owner row without a link must not be guessed from a name.
    getDb().prepare('UPDATE owners SET entity_id = NULL').run();
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests();
    handle = await startServer({ port: 0 });
    const fallback = handle.auth.ownerEntity();
    assert.notEqual(fallback.id, initial.id);
    assert.equal(getEntity(initial.id).name, 'Renamed owner');
    const session = handle.auth.createSession('owner');
    const relink = await fetch(`${base(handle)}/api/owner/entity`, { method: 'PUT', headers: { cookie: `u2os_session=${session.token}`, origin: base(handle), 'x-u2os-csrf': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ entityId: initial.id }) });
    assert.equal(relink.status, 200);
    assert.equal(handle.agent.ownerEntityId, initial.id);
    assert.equal(handle.agent.contextAssembler.ownerEntityId, initial.id);
    assert.equal((await fetch(`${base(handle)}/api/owner/entity`, { method: 'PUT', headers: { cookie: `u2os_session=${session.token}`, origin: base(handle), 'content-type': 'application/json' }, body: JSON.stringify({ entityId: fallback.id }) })).status, 403);
    assert.equal((await fetch(`${base(handle)}/api/owner/entity`, { method: 'PUT', headers: { cookie: `u2os_session=${session.token}`, origin: base(handle), 'x-u2os-csrf': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ entityId: 'missing' }) })).status, 400);
    assert.equal(getEntity(fallback.id).name, 'Owner');
  } finally { await stop(handle, dir); }
});
