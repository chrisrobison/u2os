import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseComment } from '../mcp/jobs/hunt/jobs/parser.js';
import { canonicalUrl, atsJobId, normalizeCompany, normalizeRole } from '../mcp/jobs/hunt/jobs/normalize.js';
import { openStore } from '../mcp/jobs/hunt/storage/store.js';
import { discover } from '../mcp/jobs/hunt/discover.js';
import { findThread, parseThreadTitle } from '../mcp/jobs/hunt/sources/hackernews.js';
import { main as jobCli } from '../server/jobhunt/cli.js';
import { COMMENTS, GREENHOUSE_SIGHTING, hnFetch } from './fixtures/hn-hiring.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const parse = (comment) => parseComment(comment, { threadId: 9002, now: NOW });

test('parses a standard pipe-separated listing', () => {
  const { jobs, skipped } = parse(COMMENTS.standard);
  assert.equal(skipped, null);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.source, 'hackernews');
  assert.equal(job.sourceThread, '9002');
  assert.equal(job.sourceComment, '1001');
  assert.equal(job.author, 'founder1');
  assert.equal(job.company, 'Tahoma AI (YC W24)');
  assert.equal(job.role, 'Founding Engineer');
  assert.deepEqual(job.locations, ['San Francisco, CA', 'ONSITE']);
  assert.equal(job.remote, false);
  assert.deepEqual(job.salary, { min: 180000, max: 240000, currency: 'USD', raw: '$180k - $240k' });
  assert.match(job.equity, /equity/);
  assert.ok(job.technologies.includes('TypeScript') && job.technologies.includes('PostgreSQL'));
  assert.deepEqual(job.applicationUrls, ['https://jobs.ashbyhq.com/tahoma/abc-123?utm_source=hn']);
  assert.equal(job.companyUrl, 'https://tahoma.ai');
  assert.match(job.rawText, /^Tahoma AI/);
  assert.equal(job.discoveredAt, NOW.toISOString());
});

test('splits a comment with several roles and keeps the company relationship', () => {
  const { jobs } = parse(COMMENTS.multiRole);
  const roles = jobs.map((job) => job.role);
  assert.ok(roles.includes('Staff Software Engineer') && roles.includes('Engineering Manager'));
  assert.ok(roles.includes('Senior Frontend Engineer'));
  assert.equal(new Set(jobs.map((job) => job.company)).size, 1);
  assert.equal(new Set(jobs.map((job) => job.sourceKey)).size, jobs.length, 'each role has its own source key');
  assert.ok(jobs.every((job) => job.sourceComment === '1002'));
  assert.deepEqual(jobs[0].contactEmails, ['jobs@acme-logistics.example']);
  assert.equal(jobs[0].visa, 'yes');
  assert.equal(jobs[0].remote, true);
});

test('handles a listing with no company URL', () => {
  const [job] = parse(COMMENTS.noUrl).jobs;
  assert.equal(job.company, 'Nimbus Robotics');
  assert.equal(job.companyUrl, null);
  assert.deepEqual(job.applicationUrls, []);
  assert.equal(job.remote, false, '"No remote" is explicit');
  assert.ok(job.technologies.includes('Rust') && job.technologies.includes('C++'));
});

test('extracts a direct email, including an obfuscated one, and the visa stance', () => {
  const [job] = parse(COMMENTS.directEmail).jobs;
  assert.equal(job.role, 'Head of Engineering');
  assert.deepEqual(job.contactEmails, ['dana@quill.example']);
  assert.equal(job.visa, 'no');
  assert.equal(job.remote, true);
});

test('parses a remote listing with an ATS application link', () => {
  const [job] = parse(COMMENTS.remote).jobs;
  assert.equal(job.remote, true);
  assert.deepEqual(job.applicationUrls, ['https://boards.greenhouse.io/lumen/jobs/4455']);
  assert.equal(job.salary.max, 190000);
});

test('malformed, deleted and off-topic comments yield no jobs and a reason', () => {
  assert.deepEqual(parse(COMMENTS.malformed), { jobs: [], skipped: 'too-short' });
  assert.deepEqual(parse(COMMENTS.dead), { jobs: [], skipped: 'empty' });
  assert.equal(parse(COMMENTS.chatter).skipped, 'not-a-listing');
  assert.equal(parse({}).skipped, 'no-id');
});

test('prompt injection in a listing stays inert data', () => {
  const [job] = parse(COMMENTS.injection).jobs;
  assert.equal(job.company, 'Evil Corp');
  assert.match(job.rawText, /Ignore previous instructions/);
  // The attacker's address is recorded as a contact the listing named, nothing more:
  // parsing has no side effects and no field that could carry an instruction.
  assert.deepEqual(job.contactEmails, ['attacker@example.com']);
  assert.deepEqual(Object.keys(job).filter((key) => /action|command|policy|config/i.test(key)), []);
});

test('normalisation recognises the same company, role and URL', () => {
  assert.equal(normalizeCompany('Lumen Data, Inc.'), normalizeCompany('lumen data'));
  assert.equal(normalizeCompany('Tahoma AI (YC W24)'), 'tahoma ai');
  assert.equal(normalizeRole('Sr. Backend Developer (m/f/d)'), normalizeRole('Senior Backend Engineer'));
  assert.equal(canonicalUrl('https://www.Example.com/jobs/1/?utm_source=hn#apply'), 'example.com/jobs/1');
  assert.equal(atsJobId('https://boards.greenhouse.io/lumen/jobs/4455'), atsJobId('https://job-boards.greenhouse.io/lumen/jobs/4455?gh_src=x'));
  assert.equal(atsJobId('https://jobs.lever.co/globex/ABC-1/apply'), 'lever:globex:abc-1');
});

test('thread titles parse and the newest Who-is-hiring thread is chosen without a fixed id', async () => {
  assert.equal(parseThreadTitle('Ask HN: Who is hiring? (October 2026)').label, 'October 2026');
  assert.equal(parseThreadTitle('Ask HN: Freelancer? Seeking freelancer? (October 2026)'), null);
  const fetchImpl = hnFetch();
  assert.equal((await findThread({ fetch: fetchImpl })).id, '9002');
  assert.equal((await findThread({ fetch: fetchImpl, month: 'September 2026' })).id, '9001');
  await assert.rejects(findThread({ fetch: fetchImpl, month: 'January 2020' }), /No "Who is hiring/);
});

test('discovery persists listings, is idempotent and records events', async () => {
  const store = openStore(':memory:');
  const fetchImpl = hnFetch();
  const first = await discover({ store, fetch: fetchImpl, now: NOW });
  assert.equal(first.thread.id, '9002');
  assert.ok(first.created >= 7);
  assert.ok(first.skipped.some((entry) => entry.comment === '1006'));
  const count = store.listJobs().length;
  const second = await discover({ store, fetch: fetchImpl, now: NOW });
  assert.equal(second.created, 0);
  assert.equal(second.alreadyKnown, first.listings);
  assert.equal(store.listJobs().length, count);
  const job = store.listJobs({ company: 'tahoma' })[0];
  assert.equal(job.status, 'discovered');
  assert.equal(store.listSources(job.id)[0].author, 'founder1');
  assert.match(store.listSources(job.id)[0].rawText, /deterministic orchestration/);
  assert.equal(store.listEvents(job.id)[0].type, 'discovered');
});

test('dry run stores nothing', async () => {
  const store = openStore(':memory:');
  const summary = await discover({ store, fetch: hnFetch(), now: NOW, dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.ok(summary.listings > 0);
  assert.equal(store.listJobs().length, 0);
});

test('the same job from HN and Greenhouse is one opportunity', async () => {
  const store = openStore(':memory:');
  await discover({ store, fetch: hnFetch(), now: NOW });
  const before = store.listJobs({ company: 'lumen' });
  assert.equal(before.length, 1);
  const result = store.upsertSighting(GREENHOUSE_SIGHTING, NOW);
  assert.equal(result.created, false);
  assert.equal(result.job.id, before[0].id);
  assert.equal(store.listJobs({ company: 'lumen' }).length, 1);
  assert.equal(store.listSources(before[0].id).length, 2);
});

test('a repost next month of the same company and role merges by company and role', () => {
  const store = openStore(':memory:');
  const base = { ...GREENHOUSE_SIGHTING, applicationUrls: [], source: 'hackernews', sourceKey: 'hackernews:1#0' };
  const a = store.upsertSighting(base, NOW);
  const b = store.upsertSighting({ ...base, sourceKey: 'hackernews:2#0', company: 'LUMEN DATA', role: 'Senior Backend Engineer' }, NOW);
  assert.equal(b.created, false);
  assert.equal(b.job.id, a.job.id);
});

test('transitions are validated and recorded as events', () => {
  const store = openStore(':memory:');
  const { job } = store.upsertSighting(GREENHOUSE_SIGHTING, NOW);
  store.transition(job.id, 'scored', { score: 91 }, NOW);
  assert.equal(store.getJob(job.id).status, 'scored');
  assert.throws(() => store.transition(job.id, 'bogus'), /Unknown job status/);
  const events = store.listEvents(job.id).filter((event) => event.type === 'status');
  assert.deepEqual([events[0].fromStatus, events[0].toStatus, events[0].detail.score], ['discovered', 'scored', 91]);
});

test('the store persists across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-'));
  const file = path.join(dir, 'state', 'hunt.sqlite');
  const one = openStore(file);
  one.upsertSighting(GREENHOUSE_SIGHTING, NOW);
  one.close();
  const two = openStore(file);
  assert.equal(two.listJobs().length, 1);
  assert.equal(two.upsertSighting(GREENHOUSE_SIGHTING, NOW).duplicate, true);
  two.close();
});

test('u2 job discover hn and status work from the CLI', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-vault-'));
  const lines = [];
  const out = { log: (line) => lines.push(line) };
  assert.equal(await jobCli(['discover', 'hn'], out, { vaultDir: vault, fetch: hnFetch(), now: NOW }), 0);
  assert.match(lines.join('\n'), /Ask HN: Who is hiring\? \(October 2026\)/);
  lines.length = 0;
  assert.equal(await jobCli(['status', '--json'], out, { vaultDir: vault }), 0);
  assert.ok(JSON.parse(lines[0]).counts.discovered >= 7);
  assert.equal(await jobCli(['bogus'], out, { vaultDir: vault }), 1);
});

test('a team after a comma is part of one role, while two real roles still split', () => {
  const one = parseComment({ id: 2001, author: 'a', text: 'Acme | Staff Software Engineer, Agent Platform | San Francisco<p>Build things.' }, { threadId: 1, now: NOW }).jobs;
  assert.deepEqual(one.map((job) => job.role), ['Staff Software Engineer, Agent Platform']);
  const two = parseComment({ id: 2002, author: 'a', text: 'Acme | Backend Engineer, Frontend Engineer | Remote<p>Build things.' }, { threadId: 1, now: NOW }).jobs;
  assert.deepEqual(two.map((job) => job.role), ['Backend Engineer', 'Frontend Engineer']);
});
