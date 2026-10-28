import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { openStore, huntDbPath, JOB_STATUSES } from '../mcp/jobs/hunt/storage/store.js';
import { buildOverview, overviewStageOf } from '../mcp/jobs/hunt/overview.js';
import { QUICK_FILTERS, MAX_LIMIT, escapeLike, parseOpportunitiesQuery, queryOpportunities } from '../mcp/jobs/hunt/opportunities.js';
import { seedHuntStore } from './helpers/job-hunt-dashboard-seed.js';
import { startServer } from './helpers/authed-server.js';

// #631: GET /api/job-hunt/opportunities. SQL-side filter, search, sort and paging; counts that agree with the Overview.

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);
const SCORE = { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'x', projects: [], flags: [], degraded: false, model: 'm' };

function add(store, n, company, { role = 'Engineer', score = 90, locations = ['Oakland'], remote = false, technologies = [], salary = null, postedAt = null, seen = ago(30) } = {}) {
  const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:op${n}#0`, company, role, rawText: company, applicationUrls: [], contactEmails: [], locations, remote, technologies, salary, postedAt }, seen);
  if (score != null) store.saveScore(job.id, { ...SCORE, score }, seen);
  return job;
}
const application = (store, id, status, unresolved = []) => store.addApplication(id, { kind: 'form', url: `https://x.example/${id}`, status, plan: { planHash: `h${Math.random()}`, ready: false, needs: [], blockers: [], unresolved, fields: [] }, idempotencyKey: `${id}-${status}-${Math.random()}` });
const q = (store, query) => queryOpportunities(store, query);
const names = (result) => result.items.map((item) => item.company);

test('an empty store has zero everywhere', () => {
  const store = openStore(':memory:');
  const result = q(store, {});
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 25);
  assert.deepEqual(result.counts, { all: 0, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 });
  assert.deepEqual(q(store, { q: 'x', filter: 'ready', page: '3' }).items, []);
  store.close();
});

test('items carry only stored fields: missing values are null, never invented', () => {
  const store = openStore(':memory:');
  add(store, 1, 'Bare', { role: null, score: null, locations: [], remote: null });
  add(store, 2, 'Full', { role: 'Staff Engineer', score: 88, locations: ['Oakland, CA', 'Remote'], remote: true, technologies: ['Node.js', 'SQLite'], salary: { raw: '$180K - $220K' }, postedAt: '2026-10-01T00:00:00.000Z' });
  const byName = Object.fromEntries(q(store, {}).items.map((item) => [item.company, item]));
  assert.deepEqual([byName.Bare.role, byName.Bare.fit, byName.Bare.fitLabel, byName.Bare.remote, byName.Bare.compensation, byName.Bare.postedAt, byName.Bare.locations, byName.Bare.skills], [null, null, null, null, null, null, [], []]);
  assert.deepEqual([byName.Full.role, byName.Full.fit, byName.Full.remote, byName.Full.compensation, byName.Full.postedAt, byName.Full.locations, byName.Full.skills, byName.Full.stage, byName.Full.status], ['Staff Engineer', 88, true, '$180K - $220K', '2026-10-01T00:00:00.000Z', ['Oakland, CA', 'Remote'], ['Node.js', 'SQLite'], 'discovered', 'scored']);
  assert.equal(Object.keys(byName.Full).includes('description'), false, 'no posting text or contact data in the list');
  store.close();
});

test('search covers company, role, location and skills, ANDs its words, and treats LIKE wildcards literally', () => {
  const store = openStore(':memory:');
  add(store, 1, 'Acme Robotics', { role: 'Staff Engineer', locations: ['Oakland'], technologies: ['Rust'] });
  add(store, 2, 'Globex', { role: 'Designer', locations: ['Berlin'], technologies: ['Figma'] });
  add(store, 3, '100% Real_Co', { role: 'Engineer', locations: ['Remote'] });
  add(store, 4, 'Plain', { role: 'Engineer' });
  assert.deepEqual(names(q(store, { q: 'acme' })), ['Acme Robotics'], 'company, case-insensitive');
  assert.deepEqual(names(q(store, { q: 'designer' })), ['Globex'], 'role');
  assert.deepEqual(names(q(store, { q: 'berlin' })), ['Globex'], 'location');
  assert.deepEqual(names(q(store, { q: 'figma' })), ['Globex'], 'skill');
  assert.deepEqual(names(q(store, { q: 'staff oakland rust' })), ['Acme Robotics'], 'every word must match something');
  assert.deepEqual(names(q(store, { q: 'staff berlin' })), [], 'a word that matches nothing excludes the job');
  assert.deepEqual(names(q(store, { q: '%' })), ['100% Real_Co'], '% is a literal percent sign, not a wildcard');
  assert.deepEqual(names(q(store, { q: '_' })), ['100% Real_Co'], '_ is a literal underscore');
  assert.deepEqual(names(q(store, { q: 'Real_C' })), ['100% Real_Co']);
  assert.deepEqual(names(q(store, { q: 'Pl_in' })), [], '_ does not match one arbitrary character');
  assert.deepEqual(names(q(store, { q: '\\' })), [], 'a backslash is not an escape');
  assert.deepEqual(names(q(store, { q: "x'; DROP TABLE jobs; --" })), [], 'parameterised: an injection attempt is just text');
  assert.equal(q(store, {}).total, 4, 'the table survived');
  assert.equal(escapeLike('50%_\\'), '50\\%\\_\\\\');
  assert.equal(q(store, { q: 'berlin' }).counts.all, 1, 'counts honour the search');
  store.close();
});

test('sort: each key, both directions, nulls last, and a stable id tie-break', () => {
  const store = openStore(':memory:');
  const a = add(store, 1, 'beta', { role: 'B', score: 70, postedAt: '2026-10-02T00:00:00.000Z', seen: ago(3) });
  add(store, 2, 'Alpha', { role: 'A', score: 90, postedAt: '2026-10-05T00:00:00.000Z', seen: ago(1) });
  add(store, 3, 'gamma', { role: null, score: null, postedAt: null, seen: ago(2) });
  add(store, 4, 'delta', { role: 'D', score: 70, postedAt: '2026-10-01T00:00:00.000Z', seen: ago(4) });
  store.transition(a.id, 'qualified', {}, ago(1));
  assert.deepEqual(names(q(store, { sort: 'fit' })).slice(0, 1), ['Alpha'], 'fit descending by default');
  assert.equal(names(q(store, { sort: 'fit' })).at(-1), 'gamma', 'unscored last');
  assert.equal(names(q(store, { sort: 'fit', dir: 'asc' })).at(-1), 'gamma', 'unscored last in either direction');
  assert.deepEqual(names(q(store, { sort: 'company' })), ['Alpha', 'beta', 'delta', 'gamma'], 'company A-Z ignoring case');
  assert.deepEqual(names(q(store, { sort: 'company', dir: 'desc' })), ['gamma', 'delta', 'beta', 'Alpha']);
  assert.deepEqual(names(q(store, { sort: 'role' })), ['Alpha', 'beta', 'delta', 'gamma'], 'role A, B, D, none');
  assert.deepEqual(names(q(store, { sort: 'posted' })), ['Alpha', 'beta', 'delta', 'gamma'], 'newest posted first, unposted last');
  assert.deepEqual(names(q(store, { sort: 'seen' })), ['Alpha', 'gamma', 'beta', 'delta']);
  assert.deepEqual(names(q(store, { sort: 'status' })).slice(0, 2), ['gamma', 'beta'], 'status sorts alphabetically: discovered, qualified, scored');
  const ties = names(q(store, { sort: 'fit', dir: 'desc' }));
  assert.deepEqual(q(store, { sort: 'fit', limit: '2', page: '2' }).items.map((i) => i.company), ties.slice(2, 4), 'pages are consistent slices of one stable order');
  const tied = q(store, { sort: 'fit' }).items.filter((item) => item.fit === 70).map((item) => item.id);
  assert.deepEqual(tied, [...tied].sort(), 'equal scores break ties by id');
  store.close();
});

test('pagination: limit is capped, pages are slices, a page past the end is empty, bad numbers are 400', () => {
  const store = openStore(':memory:');
  for (let i = 0; i < 7; i += 1) add(store, i, `Co${i}`, { score: 50 + i });
  const first = q(store, { limit: '3' });
  assert.deepEqual([first.items.length, first.total, first.page, first.limit], [3, 7, 1, 3]);
  assert.deepEqual(names(q(store, { limit: '3', page: '3' })), ['Co0']);
  assert.deepEqual(q(store, { limit: '3', page: '9' }).items, []);
  assert.equal(q(store, { limit: '3', page: '9' }).total, 7);
  assert.equal(q(store, { limit: '100000' }).limit, MAX_LIMIT);
  assert.equal(q(store, { limit: '0' }).limit, 1);
  assert.equal(q(store, { page: '-4' }).page, 1);
  for (const query of [{ limit: 'abc' }, { page: '1.5' }, { sort: 'description' }, { dir: 'sideways' }, { filter: 'nope' }, { stage: 'nope' }, { statuses: 'applied,nope' }, { min_score: '200' }, { min_score: 'x' }]) {
    assert.throws(() => parseOpportunitiesQuery(query), (error) => error.code === 'BAD_INPUT', JSON.stringify(query));
  }
  store.close();
});

test('combined filters: search + stage + fit floor + remote + sort + page', () => {
  const store = openStore(':memory:');
  const a = add(store, 1, 'Alpha Remote', { score: 95, remote: true }); store.transition(a.id, 'qualified', {}, ago(1));
  const b = add(store, 2, 'Alpha Onsite', { score: 96, remote: false }); store.transition(b.id, 'qualified', {}, ago(1));
  const c = add(store, 3, 'Alpha Low', { score: 40, remote: true }); store.transition(c.id, 'qualified', {}, ago(1));
  add(store, 4, 'Beta Remote', { score: 99, remote: true });
  const result = q(store, { q: 'alpha', stage: 'qualified', min_score: '80', remote: '1', sort: 'company' });
  assert.deepEqual(names(result), ['Alpha Remote']);
  assert.equal(result.total, 1);
  assert.deepEqual(q(store, { q: 'alpha', stage: 'qualified', sort: 'fit', limit: '2' }).items.map((i) => i.fit), [96, 95]);
  assert.deepEqual(names(q(store, { statuses: 'qualified', min_score: '90' })).sort(), ['Alpha Onsite', 'Alpha Remote']);
  store.close();
});

test('quick filters and counts: every count equals the total of its filter and agrees with the Overview', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-opps-'));
  seedHuntStore(vault);
  const store = openStore(huntDbPath(vault));
  const waiting = add(store, 1, 'WaitsOnYou'); store.transition(waiting.id, 'needs_input', {}, ago(1));
  application(store, waiting.id, 'needs_input', [{ key: 'custom:why', label: 'Why?', reason: 'unknown_required_field' }]);
  const unsure = add(store, 2, 'Unsure'); store.transition(unsure.id, 'applied', {}, ago(2)); store.transition(unsure.id, 'uncertain', {}, ago(1));
  const prepared = add(store, 3, 'Prepared'); store.transition(prepared.id, 'materials_generated', {}, ago(1));
  const skipped = add(store, 4, 'Skipped'); store.transition(skipped.id, 'skipped', {}, ago(1));
  add(store, 5, 'Unscored', { score: null });
  const overview = buildOverview(store);
  const result = q(store, {});
  const stage = Object.fromEntries(overview.stages.map((entry) => [entry.id, entry.count]));
  assert.equal(result.counts.all, overview.metrics.find((m) => m.id === 'discovered').value, 'All is every job, as the Overview Jobs discovered card');
  assert.equal(result.counts.needs_input, overview.attention.count);
  assert.equal(result.counts.needs_input, stage.needs_input);
  assert.equal(result.counts.applied, stage.submitted);
  assert.equal(result.counts.responded, stage.responded + stage.interviewing + stage.offer);
  assert.equal(result.counts.archived, 2, 'rejected (seed) and skipped');
  for (const entry of QUICK_FILTERS) {
    const page = q(store, { filter: entry.id, limit: '100' });
    assert.equal(page.total, result.counts[entry.id], `${entry.id}: total equals its count`);
    assert.equal(page.items.length, page.total, `${entry.id}: all rows returned`);
    assert.deepEqual(page.counts, result.counts, 'the counts do not depend on the active tab');
  }
  for (const entry of overview.stages) {
    const page = q(store, entry.flag ? { filter: 'needs_input' } : { stage: entry.id, limit: '100' });
    assert.equal(page.total, entry.count, `stage ${entry.id} link matches the Overview count`);
    if (!entry.flag) assert.ok(page.items.every((item) => item.stage === entry.id));
  }
  assert.equal(q(store, { stage: 'needs_input' }).total, overview.attention.count);
  assert.equal(q(store, { min_score: String(overview.strongMatchScore) }).total, overview.metrics.find((m) => m.id === 'strong').value, 'the Strong matches card');
  assert.equal(q(store, { statuses: 'interview' }).total, overview.metrics.find((m) => m.id === 'interviewing').value);
  assert.deepEqual(names(q(store, { filter: 'needs_input' })).sort(), ['Unsure', 'WaitsOnYou'], 'an unconfirmed outcome needs you too');
  assert.ok(q(store, { filter: 'needs_input' }).items[0].needsInput);
  assert.ok(!q(store, { filter: 'archived' }).items.some((item) => !['rejected', 'withdrawn', 'closed', 'skipped'].includes(item.status)));
  assert.ok(q(store, {}).items.find((item) => item.company === 'Unsure'), 'uncertain jobs are in All');
  assert.equal(q(store, { filter: 'applied', q: 'globex' }).counts.applied, 1, 'counts honour the search');
  assert.equal(q(store, { filter: 'applied', q: 'globex' }).counts.all, 1);
  assert.equal(q(store, { q: 'globex' }).counts.archived, 0);
  // Every status maps through the Overview stage rules.
  for (const status of JOB_STATUSES) assert.ok(overviewStageOf(status) === null || STAGE_OK.has(overviewStageOf(status)));
  store.close();
});
const STAGE_OK = new Set(['discovered', 'qualified', 'preparing', 'submitted', 'responded', 'interviewing', 'offer']);

test('Ready to Apply: a prepared draft with nothing to ask, before submission, and not waiting on the owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-opps-ready-'));
  const store = openStore(':memory:');
  const draft = (name, body) => { const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(body)); return file; };
  const make = (n, name, { status = 'materials_generated', file = { to: 'a@b.example', needsInput: [] }, email = null } = {}) => {
    const job = add(store, n, name);
    if (status !== 'scored') store.transition(job.id, status, {}, ago(1));
    if (file) store.addArtifact(job.id, 'email_json', draft(name, file), {}, ago(1));
    if (email) store.addEmail(job.id, { kind: 'application', to: 'a@b.example', subject: 's', body: 'b', attachments: [], status: email, idempotencyKey: `k-${name}` });
    return job;
  };
  make(1, 'Ready');
  make(2, 'AsksOwner', { file: { to: 'a@b.example', needsInput: ['salary expectation'] } });
  make(3, 'NoDraft', { file: null });
  make(4, 'EmailInFlight', { email: 'proposed' });
  make(5, 'AlreadySent', { status: 'applied' });
  make(6, 'DraftFailedBefore', { email: 'failed' });
  const result = q(store, { filter: 'ready' });
  assert.deepEqual(names(result).sort(), ['DraftFailedBefore', 'Ready']);
  assert.equal(result.counts.ready, 2);
  assert.equal(q(store, { filter: 'ready', q: 'asks' }).total, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt locations or technologies column cannot break the list or the search', () => {
  const store = openStore(':memory:');
  const job = add(store, 1, 'Broken', { technologies: ['Rust'] });
  store.db.prepare('UPDATE jobs SET locations = ?, technologies = ? WHERE id = ?').run('not json', '{"a":1}', job.id);
  assert.deepEqual(names(q(store, { q: 'broken' })), ['Broken']);
  assert.deepEqual(q(store, { q: 'rust' }).items, []);
  assert.deepEqual(q(store, {}).items[0].locations, []);
  store.close();
});

// ---- HTTP ---------------------------------------------------------------------

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-opps-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  fs.mkdirSync(path.join(process.env.U2OS_VAULT, 'job-hunt'), { recursive: true });
  seedHuntStore(process.env.U2OS_VAULT);
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { get: (url) => fetch(`http://127.0.0.1:${handle.port}${url}`) };
}

test('GET /api/job-hunt/opportunities returns the page, validates input and leaves /jobs alone', async (t) => {
  const { get } = await fixture(t);
  const res = await get('/api/job-hunt/opportunities?sort=company&dir=asc&limit=3&page=2');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.total, body.page, body.limit, body.items.length], [8, 2, 3, 3]);
  assert.deepEqual(body.items.map((item) => item.company), ['Hooli', 'Initech', 'Northwind']);
  assert.deepEqual(Object.keys(body.counts), ['all', 'needs_input', 'ready', 'applied', 'responded', 'archived']);
  const search = await (await get('/api/job-hunt/opportunities?q=globex')).json();
  assert.deepEqual(search.items.map((item) => item.company), ['Globex']);
  assert.equal(search.items[0].compensation, '$180K - $220K');
  assert.equal((await get('/api/job-hunt/opportunities?sort=bogus')).status, 400);
  assert.equal((await get('/api/job-hunt/opportunities?filter=%25')).status, 400);
  assert.equal((await get('/api/job-hunt/opportunities?q=%25')).status, 200);
  assert.equal((await get('/api/job-hunt/jobs')).status, 200);
});

// ---- performance --------------------------------------------------------------

test('thousands of jobs: bounded payload, SQL-side work, generous time budget', () => {
  const store = openStore(':memory:');
  const N = 5000;
  store.transaction(() => {
    for (let i = 0; i < N; i += 1) {
      const job = add(store, i, `Company ${i} ${i % 7 === 0 ? 'Robotics' : 'Labs'}`, { role: `Engineer ${i % 13}`, score: i % 11 === 0 ? null : 40 + (i % 60), locations: [i % 2 ? 'Oakland' : 'Remote'], technologies: ['Node.js', i % 3 ? 'Rust' : 'Go'], postedAt: ago(i % 90).toISOString() });
      if (i % 5 === 0) store.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(['qualified', 'applied', 'rejected', 'screening'][i % 4], job.id);
    }
  });
  const runs = [{}, { q: 'robotics oakland' }, { filter: 'archived', sort: 'company' }, { q: 'rust', sort: 'posted', page: '40' }, { stage: 'qualified', min_score: '70', limit: '100' }, { filter: 'ready' }, { filter: 'needs_input' }];
  const started = process.hrtime.bigint();
  for (const query of runs) {
    const result = q(store, query);
    assert.ok(result.items.length <= Math.min(100, Number(query.limit ?? 25)), 'a page never exceeds the limit');
    assert.ok(JSON.stringify(result).length < 100 * 1024, 'the payload stays small however many jobs there are');
    assert.equal(result.total, result.counts[result.query.filter]);
  }
  const perQueryMs = Number(process.hrtime.bigint() - started) / 1e6 / runs.length;
  assert.equal(q(store, {}).counts.all, N);
  assert.ok(perQueryMs < 1500, `average ${perQueryMs.toFixed(0)}ms per query over ${N} jobs`);
  store.close();
});
