import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { buildDashboard } from '../mcp/jobs/hunt/dashboard.js';
import { addInterview, updateInterview, deleteInterview, addTask, completeTask, uncompleteTask, snoozeTask, materializeFollowUps } from '../mcp/jobs/hunt/schedule.js';
import { startServer } from './helpers/authed-server.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const at = (days, hour = 15) => new Date(NOW.getTime() + days * DAY + (hour - 12) * 3_600_000).toISOString();
const SCORE = { score: 88, confidence: 0.9, label: 'strong', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function addJob(store, n, company, status = null) {
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${n}#0`, company, role: 'Engineer', rawText: company, applicationUrls: [], contactEmails: [], locations: [] }, new Date(NOW.getTime() - 60 * DAY));
  store.saveScore(job.id, SCORE, new Date(NOW.getTime() - 60 * DAY));
  if (status) store.transition(job.id, status, {}, new Date(NOW.getTime() - 5 * DAY));
  return job;
}

test('recording an interview moves an allowed job to interview, logs events and is idempotent per start time', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', 'applied');
  const first = addInterview(store, job.id, { at: at(2), endsAt: at(2, 16), kind: 'video', round: 'Round 1', locationOrLink: 'https://meet.example/x', notes: 'Bring the deck' }, NOW);
  assert.deepEqual([first.created, first.moved, first.status], [true, true, 'interview']);
  assert.equal(store.getJob(job.id).status, 'interview');
  const events = store.listEvents(job.id);
  assert.deepEqual(events.filter((e) => e.type === 'status').at(-1).detail, { by: 'owner', interviewId: first.interview.id });
  assert.equal(events.filter((e) => e.type === 'interview_scheduled').length, 1);
  const again = addInterview(store, job.id, { at: at(2) }, NOW);
  assert.deepEqual([again.created, again.moved, again.interview.id], [false, false, first.interview.id]);
  assert.equal(store.listInterviews({ jobId: job.id }).length, 1);
  assert.equal(store.listEvents(job.id).filter((e) => e.type === 'interview_scheduled').length, 1);
  // A second round on an interviewing job records the interview without another status change.
  const second = addInterview(store, job.id, { at: at(5), round: 'Round 2' }, NOW);
  assert.deepEqual([second.created, second.moved], [true, false]);
  store.close();
});

test('a job whose status does not allow it keeps its status but still gets the interview', () => {
  const store = openStore(':memory:');
  for (const [n, status] of ['qualified', 'offer', 'rejected'].entries()) {
    const job = addJob(store, 10 + n, status, status);
    const result = addInterview(store, job.id, { at: at(3) }, NOW);
    assert.deepEqual([result.created, result.moved, store.getJob(job.id).status], [true, false, status]);
  }
  const screening = addJob(store, 90, 'Screen', 'screening');
  assert.equal(addInterview(store, screening.id, { at: at(3) }, NOW).status, 'interview');
  store.close();
});

test('interview and task input is validated', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', 'applied');
  const bad = (fn, code = 'BAD_INPUT') => assert.throws(fn, { code });
  bad(() => addInterview(store, job.id, {}, NOW));
  bad(() => addInterview(store, job.id, { at: 'tomorrow' }, NOW));
  bad(() => addInterview(store, job.id, { at: '2026-10-12T15:00:00' }, NOW), 'BAD_INPUT'); // no zone
  bad(() => addInterview(store, job.id, { at: '2026-13-45T15:00:00Z' }, NOW));
  bad(() => addInterview(store, job.id, { at: at(2), endsAt: at(1) }, NOW));
  bad(() => addInterview(store, job.id, { at: at(2), kind: 'carrier-pigeon' }, NOW));
  bad(() => addInterview(store, job.id, { at: at(2), round: 'x'.repeat(81) }, NOW));
  bad(() => addInterview(store, job.id, { at: at(2), locationOrLink: 'x'.repeat(501) }, NOW));
  bad(() => addInterview(store, job.id, { at: at(2), notes: 5 }, NOW));
  bad(() => addInterview(store, 'job_0000000000000000', { at: at(2) }, NOW), 'UNKNOWN_JOB');
  assert.equal(store.getJob(job.id).status, 'applied', 'nothing changed on failure');
  assert.equal(store.listInterviews().length, 0);
  bad(() => addTask(store, job.id, { title: '   ' }, NOW));
  bad(() => addTask(store, job.id, { title: 'x'.repeat(201) }, NOW));
  bad(() => addTask(store, job.id, { title: 'ok', dueAt: 'soon' }, NOW));
  bad(() => addTask(store, 'job_0000000000000000', { title: 'ok' }, NOW), 'UNKNOWN_JOB');
  bad(() => completeTask(store, 999, NOW), 'UNKNOWN_TASK');
  bad(() => snoozeTask(store, 999, { days: 1 }, NOW), 'UNKNOWN_TASK');
  const task = addTask(store, job.id, { title: 'Prep' }, NOW).task;
  for (const body of [{}, { days: 0 }, { days: 31 }, { days: 1.5 }, { days: '2' }, { until: at(-1) }, { until: 'later' }]) bad(() => snoozeTask(store, task.id, body, NOW));
  store.close();
});

test('interviews can be edited and removed, and a clash is a conflict', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', 'applied');
  const a = addInterview(store, job.id, { at: at(2), round: 'One' }, NOW).interview;
  const b = addInterview(store, job.id, { at: at(4) }, NOW).interview;
  const edited = updateInterview(store, a.id, { round: 'Final', endsAt: at(2, 17), notes: null }, NOW).interview;
  assert.deepEqual([edited.round, edited.endsAt, edited.at], ['Final', at(2, 17), a.at]);
  assert.throws(() => updateInterview(store, a.id, { at: b.at, endsAt: null }, NOW), { code: 'CONFLICT' });
  assert.throws(() => updateInterview(store, a.id, { endsAt: at(1) }, NOW), { code: 'BAD_INPUT' });
  assert.throws(() => updateInterview(store, 999, { round: 'x' }, NOW), { code: 'UNKNOWN_INTERVIEW' });
  assert.equal(deleteInterview(store, a.id, NOW).removed, true);
  assert.equal(deleteInterview(store, a.id, NOW).removed, false);
  assert.deepEqual(store.listInterviews().map((i) => i.id), [b.id]);
  assert.ok(store.listEvents(job.id).some((e) => e.type === 'interview_removed'));
  store.close();
});

test('completing and uncompleting tasks is idempotent; snoozing pushes the due time out', () => {
  const store = openStore(':memory:');
  const job = addJob(store, 1, 'Alpha', 'applied');
  const task = addTask(store, job.id, { title: 'Send thank-you', dueAt: at(-1) }, NOW).task;
  const later = new Date(NOW.getTime() + 1000);
  const done = completeTask(store, task.id, NOW);
  assert.deepEqual([done.changed, done.task.doneAt], [true, NOW.toISOString()]);
  const twice = completeTask(store, task.id, later);
  assert.deepEqual([twice.changed, twice.task.doneAt], [false, NOW.toISOString()], 'the first completion time stands');
  assert.throws(() => snoozeTask(store, task.id, { days: 1 }, NOW), { code: 'CONFLICT' });
  assert.deepEqual([uncompleteTask(store, task.id, NOW).changed, uncompleteTask(store, task.id, NOW).changed], [true, false]);
  assert.equal(store.getTask(task.id).doneAt, null);
  const snoozed = snoozeTask(store, task.id, { days: 2 }, NOW).task;
  assert.equal(snoozed.snoozedUntil, at(2, 12));
  const row = buildDashboard(store, { now: NOW }).tasks.find((t) => t.id === task.id);
  assert.deepEqual([row.dueAt, row.snoozedUntil], [at(2, 12), at(2, 12)]);
  // Snoozing a task that is not yet due moves it on from its due time, not from now.
  const upcoming = addTask(store, job.id, { title: 'Later', dueAt: at(5, 9) }, NOW).task;
  assert.equal(snoozeTask(store, upcoming.id, { days: 1 }, NOW).task.snoozedUntil, at(6, 9));
  store.close();
});

test('follow-ups from sent emails become tasks once, however often the dashboard is read', () => {
  const store = openStore(':memory:');
  const sent = addJob(store, 1, 'Sent Co', 'contacted');
  const draft = addJob(store, 2, 'Draft Co', 'qualified');
  const mark = addJob(store, 3, 'Marked Co', 'followup_due');
  const answered = addJob(store, 4, 'Answered Co', 'contacted');
  const mail = (job, key, status, due) => { const email = store.addEmail(job.id, { to: 'a@b.co', subject: 's', body: 'b', status, idempotencyKey: key }, NOW); store.updateEmail(email.id, { status, detail: due ? { followUpAfter: due } : {} }, NOW); return email; };
  const sentMail = mail(sent, 'k1', 'sent', at(-2));
  mail(draft, 'k2', 'draft', at(3));
  mail(answered, 'k4', 'sent', at(-1));
  store.transition(answered.id, 'screening', {}, NOW);
  for (let i = 0; i < 3; i += 1) materializeFollowUps(store, NOW);
  const tasks = store.listTasks();
  assert.deepEqual(tasks.map((t) => t.sourceKey).sort(), [`email:${sentMail.id}`, `email:${store.listEmails(answered.id)[0].id}`, `status:${mark.id}`].sort());
  const dash = [buildDashboard(store, { now: NOW }), buildDashboard(store, { now: NOW })];
  assert.equal(store.listTasks().length, 3, 'repeated reads add no rows');
  assert.deepEqual(dash[0].tasks, dash[1].tasks);
  const open = dash[0].tasks;
  assert.deepEqual(open.map((t) => t.company), ['Sent Co', 'Marked Co'].sort((a, b) => (open.find((t) => t.company === a).dueAt < open.find((t) => t.company === b).dueAt ? -1 : 1)));
  assert.ok(open.every((t) => t.generated && t.kind === 'follow_up'));
  assert.ok(!open.some((t) => t.company === 'Answered Co'), 'a follow-up for a job that has answered is hidden');
  // Completing a generated follow-up sticks: it is not regenerated.
  completeTask(store, store.getTaskByKey(`email:${sentMail.id}`).id, NOW);
  materializeFollowUps(store, NOW);
  assert.equal(store.listTasks().length, 3);
  assert.ok(buildDashboard(store, { now: NOW }).tasks.find((t) => t.company === 'Sent Co').doneAt);
  store.close();
});

test('the dashboard lists upcoming interviews for 30 days, sorted, and open tasks first by due time', () => {
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'Alpha', 'applied');
  const b = addJob(store, 2, 'Beta', 'applied');
  addInterview(store, a.id, { at: at(10), round: 'Later' }, NOW);
  addInterview(store, b.id, { at: at(1), endsAt: at(1, 16), kind: 'phone' }, NOW);
  addInterview(store, b.id, { at: at(45) }, NOW);
  addInterview(store, b.id, { at: at(-3) }, NOW);
  const dash = buildDashboard(store, { now: NOW });
  assert.deepEqual(dash.interviews.map((i) => [i.company, i.round, i.kind]), [['Beta', null, 'phone'], ['Alpha', 'Later', 'video']]);
  assert.deepEqual(Object.keys(dash.interviews[0]).sort(), ['at', 'company', 'endsAt', 'id', 'jobId', 'kind', 'locationOrLink', 'notes', 'role', 'round']);
  const t = (title, dueAt) => addTask(store, a.id, { title, dueAt }, NOW).task;
  const late = t('Late', at(3)); const soon = t('Soon', at(1)); t('Undated', null); const old = t('Old done', at(-20));
  completeTask(store, old.id, new Date(NOW.getTime() - 10 * DAY));
  const recent = t('Recent done', at(-1)); completeTask(store, recent.id, new Date(NOW.getTime() - DAY));
  const titles = buildDashboard(store, { now: NOW }).tasks.map((x) => x.title);
  assert.deepEqual(titles, ['Soon', 'Late', 'Undated', 'Recent done']);
  assert.ok(late && soon);
  // The pre-existing payload fields are untouched.
  assert.deepEqual(Object.keys(dash).sort(), ['analytics', 'generatedAt', 'interviews', 'resumeVersions', 'stages', 'tasks']);
  store.close();
});

test('a hunt.sqlite from before interviews and tasks opens, keeps its rows and gains the tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-sched-old-'));
  const file = path.join(dir, 'hunt.sqlite');
  let store = openStore(file);
  const job = addJob(store, 1, 'Alpha', 'applied');
  const email = store.addEmail(job.id, { to: 'a@b.co', subject: 's', body: 'b', status: 'sent', idempotencyKey: 'k' }, NOW);
  store.updateEmail(email.id, { status: 'sent', detail: { followUpAfter: at(-1) } }, NOW);
  store.close();
  // Rewind to the schema before #536.
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE interviews; DROP TABLE job_tasks; PRAGMA user_version = 6');
  const before = raw.prepare('SELECT id, status, updated_at FROM jobs').all();
  const events = raw.prepare('SELECT COUNT(*) AS n FROM application_events').get().n;
  raw.close();
  store = openStore(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(store.db.prepare('SELECT id, status, updated_at FROM jobs').all(), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM application_events').get().n, events);
  assert.equal(addInterview(store, job.id, { at: at(2) }, NOW).moved, true);
  const dash = buildDashboard(store, { now: NOW });
  assert.equal(dash.interviews.length, 1);
  assert.equal(dash.tasks.length, 0, 'the follow-up belongs to a job that is now interviewing, so it is hidden');
  assert.equal(store.listTasks().length, 1, 'but it was materialized from the old email');
  store.close();
  store = openStore(file);
  assert.equal(store.listTasks().length, 1);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the owner API for interviews and tasks, and the extended dashboard', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-sched-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  const store = openStore(huntDbPath(process.env.U2OS_VAULT));
  const job = addJob(store, 1, 'Alpha', 'applied');
  const fresh = addJob(store, 2, 'Beta', 'qualified');
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const send = async (method, url, body) => { const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const future = (days) => new Date(Date.now() + days * DAY).toISOString();

  assert.equal((await send('POST', '/api/job-hunt/jobs/nope/interviews', { at: future(2) })).status, 400);
  assert.equal((await send('POST', '/api/job-hunt/jobs/job_0000000000000000/interviews', { at: future(2) })).status, 404);
  assert.equal((await send('POST', `/api/job-hunt/jobs/${job.id}/interviews`, { at: 'whenever' })).status, 400);
  const start = future(2);
  const created = await send('POST', `/api/job-hunt/jobs/${job.id}/interviews`, { at: start, endsAt: future(2.05), kind: 'phone', round: 'Screen' });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.moved, created.body.status], [true, 'interview']);
  const repeat = await send('POST', `/api/job-hunt/jobs/${job.id}/interviews`, { at: start });
  assert.deepEqual([repeat.status, repeat.body.created], [200, false]);
  const id = created.body.interview.id;
  assert.equal((await send('PATCH', `/api/job-hunt/interviews/${id}`, { round: 'Final' })).body.interview.round, 'Final');
  assert.equal((await send('PATCH', '/api/job-hunt/interviews/9999', { round: 'x' })).status, 404);
  assert.equal((await send('PATCH', '/api/job-hunt/interviews/abc', { round: 'x' })).status, 400);
  assert.equal((await send('PATCH', `/api/job-hunt/interviews/${id}`, { kind: 'nope' })).status, 400);

  const beta = await send('POST', `/api/job-hunt/jobs/${fresh.id}/interviews`, { at: future(3) });
  assert.deepEqual([beta.body.created, beta.body.moved, beta.body.status], [true, false, 'qualified']);

  const task = await send('POST', `/api/job-hunt/jobs/${job.id}/tasks`, { title: 'Thank-you note', dueAt: future(1) });
  assert.equal(task.status, 201);
  assert.equal((await send('POST', `/api/job-hunt/jobs/${job.id}/tasks`, { title: '' })).status, 400);
  const tid = task.body.task.id;
  assert.equal((await send('POST', `/api/job-hunt/tasks/${tid}/snooze`, {})).status, 400);
  assert.equal((await send('POST', `/api/job-hunt/tasks/${tid}/snooze`, { days: 2 })).status, 200);
  assert.deepEqual((await send('POST', `/api/job-hunt/tasks/${tid}/complete`)).body.changed, true);
  assert.deepEqual((await send('POST', `/api/job-hunt/tasks/${tid}/complete`)).body.changed, false);
  assert.equal((await send('POST', `/api/job-hunt/tasks/${tid}/snooze`, { days: 1 })).status, 409);
  assert.equal((await send('POST', '/api/job-hunt/tasks/9999/complete')).status, 404);

  const dash = await (await fetch(`${base}/api/job-hunt/dashboard`)).json();
  assert.deepEqual(dash.interviews.map((i) => i.company), ['Alpha', 'Beta']);
  assert.equal(dash.tasks.find((x) => x.id === tid).doneAt != null, true);
  assert.equal(dash.stages.find((s) => s.id === 'interviewing').count, 1);
  assert.equal((await send('POST', `/api/job-hunt/tasks/${tid}/uncomplete`)).body.changed, true);

  assert.equal((await send('DELETE', `/api/job-hunt/interviews/${id}`)).body.removed, true);
  assert.equal((await send('DELETE', `/api/job-hunt/interviews/${id}`)).body.removed, false);
});
