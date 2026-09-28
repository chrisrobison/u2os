import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { getVaultDir } from '../server/vault/vault-dir.js';
import { startJournal, journalEntry, journalPath, readJournal } from '../server/vault/journal.js';
import { startServer } from './helpers/authed-server.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-journal-'));
  process.env.U2OS_HOME = dir;
  const eventBus = new EventBus(getDb());
  const stop = startJournal({ eventBus });
  t.after(() => { stop(); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); });
  const lines = () => {
    const file = journalPath(Date.now());
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };
  return { eventBus, lines, vault: getVaultDir() };
}

test('owner-meaningful events are appended as one JSON line each; bookkeeping is not', (t) => {
  const { eventBus, lines } = fixture(t);
  eventBus.publish({ type: 'routine.fired', source: 'routine', actor: { type: 'routine', id: 'routines/brief.md' }, data: { routine: 'routines/brief.md', routineRunId: 'rtn_1', trigger: 'daily', slot: 'daily:2026-09-28' }, metadata: { correlationId: 'corr_1' } });
  eventBus.publish({ type: 'agent.action.approved', source: 'user', actor: { type: 'user', id: 'owner_1' }, subject: { type: 'agent_action', id: 'act_1' }, data: { tool: 'email.send' } });
  eventBus.publish({ type: 'agent.action.queue_updated', data: { status: 'queued' } });
  eventBus.publish({ type: 'vault.indexed', data: { files: 3 } });
  eventBus.publish({ type: 'email.received', subject: { type: 'email', id: 'em_1' }, data: { after: { body: 'hello' } } });
  const entries = lines();
  assert.deepEqual(entries.map((entry) => entry.type), ['routine.fired', 'agent.action.approved']);
  assert.deepEqual(entries[0].data, { routine: 'routines/brief.md', routineRunId: 'rtn_1', trigger: 'daily', slot: 'daily:2026-09-28' });
  assert.equal(entries[0].correlationId, 'corr_1');
  assert.deepEqual(entries[1].subject, { type: 'agent_action', id: 'act_1' });
  assert.ok(entries.every((entry) => entry.ts && entry.eventId));
});

test('content, arguments and provider text never reach the journal', () => {
  const proposed = journalEntry({ id: 'evt', timestamp: '2026-09-28T07:00:00Z', type: 'agent.action.proposed', source: 'agent',
    data: { tool: 'email.send', arguments: { to: 'x@example.com', body: 'SECRET body' }, reason: 'provider said PRIVATE' } });
  assert.deepEqual(proposed.data, { tool: 'email.send' });
  const candidate = journalEntry({ id: 'evt', timestamp: '2026-09-28T07:00:00Z', type: 'agent.memory_candidate.proposed', data: { candidateId: 'memc_1', content: 'SECRET fact' } });
  assert.deepEqual(candidate.data, { candidateId: 'memc_1' });
  const failed = journalEntry({ id: 'evt', timestamp: '2026-09-28T07:00:00Z', type: 'routine.failed', data: { routine: 'routines/x.md', reason: 'MODEL_UNAVAILABLE' } });
  assert.equal(failed.data.reason, 'MODEL_UNAVAILABLE');
  const odd = journalEntry({ id: 'evt', timestamp: '2026-09-28T07:00:00Z', type: 'routine.failed', data: { reason: 'provider said something private' } });
  assert.equal(odd.data, undefined);
  assert.doesNotMatch(JSON.stringify([proposed, candidate, odd]), /SECRET|PRIVATE|private/);
});

test('entries go to the month of the event, and a broken journal never breaks event delivery', (t) => {
  const { eventBus, vault } = fixture(t);
  assert.match(journalPath('2026-01-31T23:59:00Z', vault), /journal[\\/]2026-01\.jsonl$/);
  fs.mkdirSync(path.join(vault, 'journal'), { recursive: true });
  fs.mkdirSync(journalPath(Date.now(), vault)); // a directory where the file should be
  let delivered = 0;
  eventBus.subscribe('task.created', () => { delivered += 1; });
  assert.doesNotThrow(() => eventBus.publish({ type: 'task.created', subject: { type: 'task', id: 'task_1' } }));
  assert.equal(delivered, 1);
});

test('a routine run on a live server is journaled in the vault', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-journal-server-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(process.env.U2OS_VAULT, 'routines', 'plants.md'), '---\nwhen:\n  every_minutes: 60\n---\nremind me to water the plants\n');
  const run = await fetch(`http://127.0.0.1:${handle.port}/api/routines/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'routines/plants.md' }) });
  assert.equal(run.status, 200);
  const entries = fs.readFileSync(journalPath(Date.now(), process.env.U2OS_VAULT), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const types = entries.map((entry) => entry.type);
  assert.ok(types.includes('routine.fired') && types.includes('routine.completed'));
  assert.ok(entries.some((entry) => entry.type === 'agent.action.completed' && entry.data?.tool === 'tasks.create'), 'what it did on my behalf');
  assert.doesNotMatch(fs.readFileSync(journalPath(Date.now(), process.env.U2OS_VAULT), 'utf8'), /water the plants/, 'no content');
  const api = await (await fetch(`http://127.0.0.1:${handle.port}/api/vault/journal`)).json();
  assert.equal(api.entries[0].type, 'routine.completed', 'newest first');
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/api/vault/journal?month=../../etc`)).status, 400);
});

test('the journal reader lists months and returns the newest entries, skipping damaged lines', (t) => {
  const { vault } = fixture(t);
  fs.mkdirSync(path.join(vault, 'journal'), { recursive: true });
  const line = (i) => JSON.stringify({ ts: `2026-08-0${i}T00:00:00Z`, type: 'task.created', eventId: `evt_${i}` });
  fs.writeFileSync(path.join(vault, 'journal', '2026-08.jsonl'), `${line(1)}\n{broken\n${line(2)}\n${line(3)}\n`);
  fs.writeFileSync(path.join(vault, 'journal', '2026-07.jsonl'), `${line(4)}\n`);
  fs.writeFileSync(path.join(vault, 'journal', 'notes.txt'), 'ignored');
  const latest = readJournal({ vaultDir: vault, limit: 2 });
  assert.deepEqual(latest.months, ['2026-08', '2026-07']);
  assert.deepEqual(latest.entries.map((entry) => entry.eventId), ['evt_3', 'evt_2']);
  assert.deepEqual(readJournal({ vaultDir: vault, month: '2026-07' }).entries.map((entry) => entry.eventId), ['evt_4']);
  assert.deepEqual(readJournal({ vaultDir: vault, month: '2026-01' }).entries, []);
  assert.throws(() => readJournal({ vaultDir: vault, month: '../x' }), /month must/);
});
