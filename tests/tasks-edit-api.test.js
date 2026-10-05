import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-tasks-edit-'));
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
  return { get: (url) => fetch(`${base}${url}`), post: (u, b) => send(u, 'POST', b), patch: (u, b) => send(u, 'PATCH', b) };
}

test('an owner can edit a task title, due date and status, and clear the due date', async (t) => {
  const { get, post, patch } = await fixture(t);
  const id = (await (await post('/api/tasks', { title: 'Call school', dueAt: '2030-01-01T00:00:00.000Z' })).json()).result.id;

  let res = await patch(`/api/tasks/${id}`, { title: '  Call the school  ', dueAt: '2030-02-02T00:00:00.000Z' });
  assert.equal(res.status, 200);
  assert.deepEqual([(await res.json()).task.title, (await (await get('/api/tasks')).json()).tasks.find((x) => x.id === id).due_at], ['Call the school', '2030-02-02T00:00:00.000Z']);

  res = await patch(`/api/tasks/${id}`, { dueAt: null, status: 'completed' });
  const task = (await res.json()).task;
  assert.equal(task.due_at, null);
  assert.equal(task.status, 'completed');
  assert.equal(task.title, 'Call the school', 'unsupplied fields are untouched');

  assert.equal((await (await patch(`/api/tasks/${id}`, { status: 'open' })).json()).task.status, 'open', 'a task can be reopened');
});

test('bad edits are rejected and change nothing', async (t) => {
  const { get, post, patch } = await fixture(t);
  const id = (await (await post('/api/tasks', { title: 'Keep me' })).json()).result.id;
  for (const body of [{}, { title: '   ' }, { title: 'x'.repeat(201) }, { dueAt: 'soon' }, { status: 'later' }, { title: 5 }]) {
    assert.equal((await patch(`/api/tasks/${id}`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await patch('/api/tasks/task_missing', { title: 'x' })).status, 404);
  assert.equal((await (await get('/api/tasks')).json()).tasks.find((x) => x.id === id).title, 'Keep me');
});

test('an edit is recorded as an event without the new values', async (t) => {
  const { get, post, patch } = await fixture(t);
  const id = (await (await post('/api/tasks', { title: 'Original' })).json()).result.id;
  await patch(`/api/tasks/${id}`, { title: 'A private new title' });
  const events = await (await get('/api/events?limit=50')).json();
  const edit = (events.events || events).find((e) => e.type === 'task.updated');
  assert.ok(edit, 'a task.updated event exists');
  assert.doesNotMatch(JSON.stringify(edit), /A private new title/);
});
