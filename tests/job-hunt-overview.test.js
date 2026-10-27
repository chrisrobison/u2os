import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath, JOB_STATUSES } from '../mcp/jobs/hunt/storage/store.js';
import { OVERVIEW_STAGES, OFF_PIPELINE_STATUSES, STRONG_MATCH_SCORE, overviewStageOf, autopilotIndicator, buildOverview } from '../mcp/jobs/hunt/overview.js';
import { scoreLabel } from '../mcp/jobs/hunt/jobs/scorer.js';
import { seedHuntStore } from './helpers/job-hunt-dashboard-seed.js';
import { startServer } from './helpers/authed-server.js';

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);
const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function addJob(store, n, company, { score = 90, firstSeen = ago(60) } = {}) {
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:ov${n}#0`, company, role: 'Engineer', rawText: company, applicationUrls: [], contactEmails: [], locations: ['Oakland'], remote: false }, firstSeen);
  if (score != null) store.saveScore(job.id, { ...SCORE, score }, firstSeen);
  return job;
}
const plan = (unresolved) => ({ planHash: `h${Math.random()}`, ready: false, needs: [], blockers: [], unresolved, fields: [] });
const application = (store, id, status, unresolved = []) => store.addApplication(id, { kind: 'form', url: `https://x.example/${id}`, status, plan: plan(unresolved), idempotencyKey: `${id}-${status}-${Math.random()}` });

test('every one of the 19 job statuses maps to exactly one stage or is explicitly off the pipeline', () => {
  assert.equal(JOB_STATUSES.length, 19);
  const staged = OVERVIEW_STAGES.flatMap((stage) => stage.statuses);
  assert.equal(new Set(staged).size, staged.length, 'no status is in two stages');
  for (const status of JOB_STATUSES) {
    const stage = overviewStageOf(status);
    assert.ok(stage ? staged.includes(status) : OFF_PIPELINE_STATUSES.includes(status), `${status} is mapped or listed off-pipeline`);
    assert.ok(!(stage && OFF_PIPELINE_STATUSES.includes(status)), `${status} is not both`);
  }
  assert.deepEqual([...staged, ...OFF_PIPELINE_STATUSES].sort(), [...JOB_STATUSES].sort());
  assert.deepEqual(OVERVIEW_STAGES.map((stage) => stage.id), ['discovered', 'qualified', 'preparing', 'needs_input', 'submitted', 'responded', 'interviewing', 'offer']);
  assert.equal(OVERVIEW_STAGES.find((stage) => stage.id === 'needs_input').flag, true);
  const expected = { discovered: 'discovered', scored: 'discovered', researching: 'discovered', qualified: 'qualified', materials_generated: 'preparing', applying: 'preparing', needs_input: 'preparing', applied: 'submitted', contacted: 'submitted', followup_due: 'submitted', screening: 'responded', interview: 'interviewing', offer: 'offer', rejected: null, uncertain: null };
  for (const [status, stage] of Object.entries(expected)) assert.equal(overviewStageOf(status), stage, status);
  assert.equal(overviewStageOf('made-up'), null);
});

test('the strong-match line is the existing scorer line', () => {
  assert.equal(STRONG_MATCH_SCORE, 80);
  assert.equal(scoreLabel(STRONG_MATCH_SCORE), 'strong');
  assert.notEqual(scoreLabel(STRONG_MATCH_SCORE - 1), 'strong');
});

test('autopilot mode is separate from execution and absent without an autopilot', () => {
  assert.equal(autopilotIndicator(null), null);
  const base = { error: null, running: false, lastReport: null };
  assert.deepEqual(autopilotIndicator({ ...base, config: { enabled: false, mode: 'live' } }), { mode: 'paused', execution: 'idle', detail: null, lastRunAt: null });
  assert.equal(autopilotIndicator({ ...base, config: { enabled: true, mode: 'dry_run' } }).mode, 'dry_run');
  assert.equal(autopilotIndicator({ ...base, running: true, config: { enabled: true, mode: 'live' } }).mode, 'live');
  assert.equal(autopilotIndicator({ ...base, running: true, config: { enabled: true, mode: 'live' } }).execution, 'running');
  const degraded = autopilotIndicator({ ...base, config: { enabled: true, mode: 'live' }, lastReport: { finishedAt: '2026-10-01T00:00:00Z', errors: ['score: model unreachable'] } });
  assert.deepEqual([degraded.mode, degraded.execution, degraded.detail, degraded.lastRunAt], ['live', 'degraded', 'score: model unreachable', '2026-10-01T00:00:00Z']);
  const blocked = autopilotIndicator({ config: null, error: 'autopilot.yaml: bad', running: false, lastReport: null });
  assert.deepEqual([blocked.mode, blocked.execution, blocked.detail], ['paused', 'blocked', 'autopilot.yaml: bad']);
});

test('an empty store gives zeros, no attention and no activity', () => {
  const store = openStore(':memory:');
  const overview = buildOverview(store);
  assert.deepEqual(overview.metrics.map((metric) => metric.value), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(overview.stages.map((stage) => stage.count), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(overview.attention, { count: 0, items: [] });
  assert.deepEqual(overview.activity, []);
  assert.equal(overview.autopilot, null);
  store.close();
});

test('counts come from the seeded store: stage membership of the current status, event-derived submitted and responded', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-overview-'));
  seedHuntStore(vault);
  const store = openStore(huntDbPath(vault));
  addJob(store, 1, 'Zed', { score: null });
  const overview = buildOverview(store, { minimumScore: 82 });
  const byStage = Object.fromEntries(overview.stages.map((stage) => [stage.id, stage.count]));
  // seed: 2 qualified, applied + followup_due (2 submitted), screening, interview, offer, rejected; plus the unscored discovered job
  assert.deepEqual(byStage, { discovered: 1, qualified: 2, preparing: 0, needs_input: 0, submitted: 2, responded: 1, interviewing: 1, offer: 1 });
  assert.equal(overview.offPipeline, 1);
  assert.equal(overview.stages.filter((stage) => !stage.flag).reduce((n, stage) => n + stage.count, 0) + overview.offPipeline, 9, 'lifecycle stages plus off-pipeline add up to every job');
  const metric = Object.fromEntries(overview.metrics.map((m) => [m.id, m]));
  assert.equal(metric.discovered.value, 9);
  assert.equal(metric.strong.value, 5, 'scores of 80 or more: 92, 85, 90, 88, 91');
  assert.equal(metric.submitted.value, 6, 'jobs ever sent: applied-1, applied-2, screening, interview, offer, rejected');
  assert.equal(metric.responded.value, 4, 'screening, interview, offer and rejected after being sent');
  assert.equal(metric.interviewing.value, 1);
  assert.equal(metric.attention.value, 0);
  assert.equal(overview.minimumScore, 82);
  assert.ok(overview.activity.length > 0 && overview.activity.every((item) => item.jobId && item.label && item.company));
  assert.ok(!overview.activity.some((item) => /scor|discover/i.test(item.label)), 'scoring and discovery are not activity');
  assert.ok(overview.activity.length <= 12);
  assert.ok(overview.activity[0].at >= overview.activity.at(-1).at, 'newest first');
  store.close();
});

test('the attention queue sorts by urgency, then score, then severity, and links the outstanding question', () => {
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'LowScoreBlocked', { score: 70 });
  store.transition(a.id, 'needs_input', {}, ago(3));
  application(store, a.id, 'manual_required');
  const b = addJob(store, 2, 'HighScoreAnswers', { score: 95 });
  store.transition(b.id, 'needs_input', {}, ago(2));
  application(store, b.id, 'needs_input', [{ key: 'custom:why', label: 'Why are you interested?', reason: 'unknown_required_field' }]);
  const c = addJob(store, 3, 'MidScoreUncertain', { score: 85 });
  store.transition(c.id, 'applied', {}, ago(5));
  store.transition(c.id, 'uncertain', {}, ago(4));
  const d = addJob(store, 4, 'InterviewSoon', { score: 60 });
  store.transition(d.id, 'needs_input', {}, ago(1));
  application(store, d.id, 'needs_input', [{ key: 'custom:visa', label: 'Visa status?', reason: 'unknown_required_field' }]);
  store.addInterview(d.id, { at: new Date(Date.now() + 2 * DAY).toISOString(), kind: 'video' });
  const settled = addJob(store, 5, 'Settled', { score: 99 });
  store.transition(settled.id, 'applied', {}, ago(1));
  const { attention } = buildOverview(store);
  assert.equal(attention.count, 4);
  assert.deepEqual(attention.items.map((item) => item.company), ['InterviewSoon', 'HighScoreAnswers', 'MidScoreUncertain', 'LowScoreBlocked']);
  const [soon, answers, uncertain, blocked] = attention.items;
  assert.equal(soon.urgency, 1);
  assert.ok(soon.deadline);
  assert.deepEqual(answers.question, { key: 'custom:why', label: 'Why are you interested?' });
  assert.equal(answers.jobId, b.id);
  assert.equal(answers.kind, 'needs_answers');
  assert.equal(uncertain.kind, 'uncertain');
  assert.equal(uncertain.severity, 3);
  assert.equal(uncertain.question, null);
  assert.equal(blocked.kind, 'blocked');
  assert.ok(attention.items.every((item) => item.explanation && item.since));
  store.close();
});

test('with equal urgency and score, higher blocking severity comes first', () => {
  const store = openStore(':memory:');
  const a = addJob(store, 1, 'Answers', { score: 90 }); store.transition(a.id, 'needs_input', {}, ago(2));
  application(store, a.id, 'needs_input', [{ key: 'custom:x', label: 'X?', reason: 'unknown_required_field' }]);
  const b = addJob(store, 2, 'Captcha', { score: 90 }); store.transition(b.id, 'needs_input', {}, ago(1));
  application(store, b.id, 'manual_required');
  assert.deepEqual(buildOverview(store).attention.items.map((item) => item.company), ['Captcha', 'Answers']);
  store.close();
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-overview-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  const ids = seedHuntStore(process.env.U2OS_VAULT);
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ids, get: (url) => fetch(`http://127.0.0.1:${handle.port}${url}`) };
}

test('GET /api/job-hunt/overview returns the view model and leaves the dashboard endpoint alone', async (t) => {
  const { get } = await fixture(t);
  const res = await get('/api/job-hunt/overview');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stages.map((stage) => stage.id), ['discovered', 'qualified', 'preparing', 'needs_input', 'submitted', 'responded', 'interviewing', 'offer']);
  assert.equal(body.metrics.find((metric) => metric.id === 'discovered').value, 8);
  assert.equal(body.metrics.find((metric) => metric.id === 'submitted').value, 6);
  assert.equal(body.strongMatchScore, 80);
  assert.equal(body.minimumScore, 82);
  assert.equal(body.autopilot?.mode, 'paused', 'the demo autopilot is off by default');
  assert.ok(['idle', 'running', 'degraded', 'blocked'].includes(body.autopilot.execution));
  assert.ok(Array.isArray(body.attention.items) && Array.isArray(body.activity));
  const dashboard = await (await get('/api/job-hunt/dashboard')).json();
  assert.deepEqual(dashboard.stages.map((stage) => stage.id), ['saved', 'applied', 'screening', 'interviewing', 'offer', 'rejected']);
});
