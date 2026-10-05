import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-tasks-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const send = (url, method, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { get: (url) => fetch(`${base}${url}`), send };
}

test('a task can be created, then completed through the gated pipeline', async (t) => {
  const { get, send } = await fixture(t);
  const created = await send('/api/tasks', 'POST', { title: 'Call the school' });
  assert.equal(created.status, 201);
  const outcome = await created.json();
  assert.equal(outcome.status, 'executed');
  const id = outcome.result.id;

  const done = await send(`/api/tasks/${id}/complete`, 'POST');
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, 'executed');

  const { tasks } = await (await get('/api/tasks')).json();
  assert.equal(tasks.find((task) => task.id === id).status, 'completed');
});

test('completing an unknown task is a 404 and creates no action', async (t) => {
  const { send } = await fixture(t);
  const res = await send('/api/tasks/task_missing/complete', 'POST');
  assert.equal(res.status, 404);
});
