import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath, JOB_STATUSES } from '../mcp/jobs/hunt/storage/store.js';
import { buildDashboard, computeAnalytics, moveJob, stageOf } from '../mcp/jobs/hunt/dashboard.js';
import { startServer } from './helpers/authed-server.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000);
const SCORE = { score: 88, confidence: 0.9, label: 'strong', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function addJob(store, n, company, { score = true } = {}) {
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${n}#0`, company, role: 'Engineer', rawText: company, applicationUrls: [], contactEmails: [], locations: ['Oakland'], remote: false, companyUrl: `https://${company.toLowerCase()}.example` }, ago(60));
  if (score) store.saveScore(job.id, SCORE, ago(60));
  return job;
}
const walk = (store, id, steps) => steps.forEach(([status, days]) => store.transition(id, status, {}, ago(days)));

test('stage mapping covers the documented statuses and leaves the rest off the board', () => {
  assert.deepEqual(['qualified', 'materials_generated'].map(stageOf), ['saved', 'saved']);
  assert.deepEqual(['applied', 'contacted', 'followup_due'].map(stageOf), ['applied', 'applied', 'applied']);
  assert.deepEqual(['screening', 'interview', 'offer', 'rejected'].map(stageOf), ['screening', 'interviewing', 'offer', 'rejected']);
  for (const status of ['discovered', 'scored', 'withdrawn', 'uncertain', 'error']) assert.equal(stageOf(status), null);
  assert.ok(JOB_STATUSES.includes('screening') && JOB_STATUSES.includes('offer'));
});

test('analytics are cohort based with change against the previous window, and zero denominators are null', () => {
  const store = openStore(':memory:');
  const empty = computeAnalytics(store.listStatusEvents(), { now: NOW });
  assert.equal(empty.responseRate.value, null);
  assert.equal(empty.interviewRate.change, null);
  assert.equal(empty.applicationsSent.value, 0);

  const a = addJob(store, 1, 'Alpha'); walk(store, a.id, [['applied', 5], ['screening', 3], ['interview', 2], ['offer', 1]]);
  const b = addJob(store, 2, 'Beta'); walk(store, b.id, [['contacted', 4], ['rejected', 2]]);
  const c = addJob(store, 3, 'Gamma'); walk(store, c.id, [['applied', 6]]);
  const d = addJob(store, 4, 'Delta'); walk(store, d.id, [['applied', 40], ['interview', 35]]); // previous window
  const e = addJob(store, 5, 'Eps'); walk(store, e.id, [['rejected', 3]]); // never sent: not a response
  const x = computeAnalytics(store.listStatusEvents(), { now: NOW });
  assert.deepEqual([x.applicationsSent.value, x.applicationsSent.previous, x.applicationsSent.change], [3, 1, 2]);
  assert.equal(x.responseRate.value, 2 / 3);
  assert.equal(x.interviewRate.value, 1 / 3);
  assert.equal(x.interviewRate.previous, 1);
  assert.ok(Math.abs(x.interviewRate.change - (1 / 3 - 1)) < 1e-9);
  assert.deepEqual([x.offers.value, x.offers.previous], [1, 0]);
  assert.equal(x.sentByDay.reduce((n, day) => n + day.count, 0), 3);
  store.close();
});

test('the dashboard groups cards by stage with fit, location and timestamp, and lists resume versions with the jobs that used them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-dash-'));
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'Alpha'); walk(store, a.id, [['qualified', 10], ['applied', 5]]);
  const b = addJob(store, 2, 'Beta', { score: false }); walk(store, b.id, [['qualified', 9]]);
  const c = addJob(store, 3, 'Gamma'); walk(store, c.id, [['qualified', 8]]);
  const pdf1 = path.join(dir, 'one.pdf'); fs.writeFileSync(pdf1, 'one');
  const pdf2 = path.join(dir, 'two.pdf'); fs.writeFileSync(pdf2, 'two');
  store.addArtifact(a.id, 'resume_pdf', pdf1, {}, ago(5));
  store.addArtifact(b.id, 'resume_pdf', pdf1, {}, ago(4));
  store.addArtifact(c.id, 'resume_pdf', pdf2, {}, ago(3));
  store.addArtifact(a.id, 'email_json', pdf2, {}, ago(3));
  const dash = buildDashboard(store, { now: NOW });
  assert.deepEqual(dash.stages.map((s) => s.id), ['saved', 'applied', 'screening', 'interviewing', 'offer', 'rejected']);
  const saved = dash.stages[0];
  assert.equal(saved.count, 2);
  assert.deepEqual(saved.jobs.map((j) => j.company), ['Gamma', 'Beta'], 'newest first');
  assert.equal(saved.jobs[1].fit, null);
  assert.deepEqual(dash.stages[1].jobs[0], { id: a.id, company: 'Alpha', role: 'Engineer', location: 'Oakland', fit: 88, status: 'applied', statusLine: 'Applied', timestamp: ago(5).toISOString(), companyUrl: 'https://alpha.example' });
  assert.equal(dash.resumeVersions.length, 2, 'two distinct resumes; other kinds ignored');
  assert.equal(dash.resumeVersions[0].job.company, 'Gamma');
  const shared = dash.resumeVersions.find((v) => v.usedBy.length === 2);
  assert.deepEqual(shared.usedBy.map((j) => j.company).sort(), ['Alpha', 'Beta']);
  assert.equal(shared.job.company, 'Beta', 'latest job to use it');
  assert.equal(shared.file, 'one.pdf');
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('moving a job validates the transition, records the event and is idempotent', () => {
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'Alpha'); walk(store, a.id, [['applied', 5]]);
  assert.throws(() => moveJob(store, a.id, 'interview', NOW), { code: 'BAD_TARGET' });
  assert.throws(() => moveJob(store, 'job_0000000000000000', 'offer', NOW), { code: 'UNKNOWN_JOB' });
  const first = moveJob(store, a.id, 'screening', NOW);
  assert.equal(first.changed, true);
  assert.equal(first.job.status, 'screening');
  assert.equal(moveJob(store, a.id, 'screening', NOW).changed, false);
  assert.equal(store.listEvents(a.id).filter((e) => e.toStatus === 'screening').length, 1);
  assert.deepEqual(store.listEvents(a.id).at(-1).detail, { by: 'owner' });
  const fresh = addJob(store, 2, 'Beta');
  assert.throws(() => moveJob(store, fresh.id, 'offer', NOW), { code: 'BAD_TRANSITION' });
  assert.throws(() => moveJob(store, fresh.id, 'screening', NOW), { code: 'BAD_TRANSITION' });
  assert.equal(moveJob(store, a.id, 'rejected', NOW).changed, true);
  assert.throws(() => moveJob(store, a.id, 'offer', NOW), { code: 'BAD_TRANSITION' });
  store.close();
});

test('a hunt.sqlite created before screening and offer existed still opens, keeps its rows and accepts the new statuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-dash-old-'));
  const file = path.join(dir, 'hunt.sqlite');
  let store = openStore(file);
  const a = addJob(store, 1, 'Alpha'); walk(store, a.id, [['applied', 5], ['interview', 2]]);
  const b = addJob(store, 2, 'Beta'); walk(store, b.id, [['contacted', 3]]);
  store.close();
  const raw = new DatabaseSync(file);
  const before = raw.prepare('SELECT id, status, updated_at FROM jobs ORDER BY id').all();
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get().sql;
  raw.close();
  assert.doesNotMatch(schema, /CHECK/i, 'status is free text, so no table rewrite is needed');
  store = openStore(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, version, 'no schema migration was added');
  assert.deepEqual(store.db.prepare('SELECT id, status, updated_at FROM jobs ORDER BY id').all(), before);
  const dash = buildDashboard(store, { now: NOW });
  assert.equal(dash.stages.find((s) => s.id === 'interviewing').count, 1);
  assert.equal(dash.stages.find((s) => s.id === 'applied').count, 1);
  assert.equal(moveJob(store, b.id, 'screening', NOW).job.status, 'screening');
  assert.equal(store.getJob(b.id).status, 'screening');
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /api/job-hunt/dashboard and POST .../status over the owner API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-dash-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  const store = openStore(huntDbPath(process.env.U2OS_VAULT));
  const job = addJob(store, 1, 'Alpha'); store.transition(job.id, 'applied', {}, new Date());
  store.close();
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const dash = await (await fetch(`${base}/api/job-hunt/dashboard`)).json();
  assert.equal(dash.analytics.window.days, 30);
  assert.equal(dash.analytics.applicationsSent.value, 1);
  assert.equal(dash.stages.find((s) => s.id === 'applied').jobs[0].company, 'Alpha');
  assert.equal((await fetch(`${base}/api/job-hunt/dashboard?days=7`)).status, 200);
  for (const bad of ['0', '400', 'x', '1.5']) assert.equal((await fetch(`${base}/api/job-hunt/dashboard?days=${bad}`)).status, 400);

  const url = `/api/job-hunt/jobs/${job.id}/status`;
  assert.equal((await post(url, { status: 'interview' })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/nope/status', { status: 'offer' })).status, 400);
  assert.equal((await post('/api/job-hunt/jobs/job_0000000000000000/status', { status: 'offer' })).status, 404);
  const moved = await (await post(url, { status: 'screening' })).json();
  assert.equal(moved.changed, true);
  assert.equal(moved.job.status, 'screening');
  assert.equal((await (await post(url, { status: 'screening' })).json()).changed, false);
  const after = await (await fetch(`${base}/api/job-hunt/dashboard`)).json();
  assert.equal(after.stages.find((s) => s.id === 'screening').count, 1);
  assert.equal(after.analytics.interviewRate.numerator, 1);
});
