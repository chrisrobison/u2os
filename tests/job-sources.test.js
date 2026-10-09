import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBoard, parseBoard } from '../mcp/jobs/hunt/sources/ats.js';
import { discoverHnJobs, pageSummary, parseTitle } from '../mcp/jobs/hunt/sources/hnjobs.js';
import { discoverRemoteOk, discoverWeWorkRemotely, parseRss, REMOTEOK_CREDIT } from '../mcp/jobs/hunt/sources/remote.js';
import { deriveBoards, loadBoardConfig, resolveBoards } from '../mcp/jobs/hunt/sources/boards.js';
import { refilterStored, skipReason } from '../mcp/jobs/hunt/jobs/relevance.js';
import { discoverBoards, discoverSources } from '../mcp/jobs/hunt/discover-sources.js';
import { openStore } from '../mcp/jobs/hunt/storage/store.js';
import { discover } from '../mcp/jobs/hunt/discover.js';
import { main as jobCli } from '../server/jobhunt/cli.js';
import { PREFS } from './fixtures/job-hunt-candidate.js';
import { COMMENTS, hnFetch } from './fixtures/hn-hiring.js';
import { sourcesFetch } from './fixtures/job-sources.js';

const NOW = new Date('2026-10-08T12:00:00Z');

test('board names are validated', () => {
  assert.deepEqual(parseBoard('greenhouse:acme'), { kind: 'greenhouse', slug: 'acme' });
  for (const bad of ['workday:x', 'greenhouse:', 'lever:a/b', 'greenhouse:../x', 'ashby:a b']) assert.throws(() => parseBoard(bad), /must look like/, bad);
});

test('Greenhouse: description, location, pay range, apply URL and the ATS id come through', async () => {
  const [staff] = await fetchBoard('greenhouse:acme', { fetch: sourcesFetch() });
  assert.equal(staff.company, 'Acme AI');
  assert.equal(staff.role, 'Staff Software Engineer, Agent Platform');
  assert.equal(staff.sourceKey, 'greenhouse:acme:4461450008');
  assert.match(staff.description, /deterministic control around LLMs/);
  assert.doesNotMatch(staff.description, /&lt;|<div/, 'escaped HTML is decoded and stripped');
  assert.deepEqual(staff.locations, ['San Francisco, CA']);
  assert.deepEqual(staff.salary, { min: 220000, max: 280000, currency: 'USD', raw: '$220k - $280k' });
  assert.deepEqual(staff.applicationUrls, ['https://job-boards.greenhouse.io/acme/jobs/4461450008']);
  assert.ok(staff.technologies.includes('Python') && staff.technologies.includes('Kubernetes'));
});

test('Lever and Ashby: workplace type, compensation, hidden postings and apply URLs', async () => {
  const [lever, designer] = await fetchBoard('lever:globex', { fetch: sourcesFetch() });
  assert.equal(lever.remote, true);
  assert.equal(designer.remote, null, 'hybrid is neither remote nor on-site');
  assert.deepEqual(lever.salary, { min: 200000, max: 240000, currency: 'USD', raw: '$200k - $240k' });
  assert.match(lever.description, /Run the team/);
  assert.equal(lever.applicationUrls[0], 'https://jobs.lever.co/globex/abc-123/apply');
  const ashby = await fetchBoard('ashby:tahoma', { fetch: sourcesFetch() });
  assert.equal(ashby.length, 1, 'unlisted jobs are not read');
  assert.equal(ashby[0].salary.max, 240000);
  assert.deepEqual(ashby[0].locations, ['San Francisco', 'Remote - US']);
  assert.equal(await fetchBoard('lever:nobody', { fetch: sourcesFetch({ missing: ['nobody'] }) }).then((jobs) => jobs.length), 0, 'a board that does not exist is empty, not an error');
  await assert.rejects(fetchBoard('lever:globex', { fetch: sourcesFetch({ fail: ['lever'] }) }), /answered 500/);
});

test('HN jobs feed: titles parse, pages fill in missing roles, dead items are dropped', async () => {
  assert.deepEqual(parseTitle('Quill (YC S21) is hiring a Staff Platform Engineer'), { company: 'Quill (YC S21)', role: 'Staff Platform Engineer' });
  assert.deepEqual(parseTitle('RetailReady (YC W24) Is Hiring'), { company: 'RetailReady (YC W24)', role: null });
  assert.equal(parseTitle('Senior Engineer at Acme | Remote').company, 'Acme');
  assert.deepEqual(pageSummary('<title>A &amp; B</title><meta name="description" content="d"><script>x</script><p>Body</p>').title, 'A & B');
  const { sightings } = await discoverHnJobs({ fetch: sourcesFetch() });
  assert.equal(sightings.length, 2);
  const retail = sightings.find((s) => s.company.startsWith('RetailReady'));
  assert.equal(retail.role, 'Implementations Engineer', 'the role comes from the posting page');
  assert.equal(retail.salary.max, 190000);
  assert.equal(retail.author, 'sarah74');
  assert.equal(retail.sourceKey, 'hnjob:9101');
  const quill = sightings.find((s) => s.company.startsWith('Quill'));
  assert.deepEqual(quill.contactEmails, ['founders@quill.example']);
});

test('RemoteOK keeps its credit; We Work Remotely RSS parses CDATA and entities', async () => {
  const { sightings } = await discoverRemoteOk({ fetch: sourcesFetch() });
  assert.equal(sightings.length, 2, 'the legal notice is not a job');
  assert.equal(sightings[0].attribution, REMOTEOK_CREDIT);
  assert.equal(sightings[0].remote, true);
  assert.equal(sightings[0].salary.min, 160000);
  assert.equal(sightings[1].salary, null);
  assert.equal(parseRss('<item><title><![CDATA[A: B]]></title><link>https://x.test/a</link></item>')[0].title, 'A: B');
  const wwr = await discoverWeWorkRemotely({ fetch: sourcesFetch(), feeds: ['remote-programming-jobs'] });
  assert.equal(wwr.sightings.length, 2);
  assert.equal(wwr.sightings[0].company, 'Dremio');
  assert.equal(wwr.sightings[0].role, 'Software Engineer - Developer Experience');
  assert.equal(wwr.sightings[0].salary.max, 180000);
  assert.deepEqual(wwr.sightings[0].locations, ['Anywhere in the World']);
});

test('relevance: engineering, not junior, not sales, workable location', () => {
  const base = { role: 'Staff Software Engineer', locations: ['San Francisco'], remote: false };
  assert.equal(skipReason(base, PREFS), null);
  assert.equal(skipReason({ ...base, role: 'Account Executive' }, PREFS), 'not an engineering role at the right level');
  assert.equal(skipReason({ ...base, role: 'Junior Software Engineer' }, PREFS), 'not an engineering role at the right level');
  assert.equal(skipReason({ ...base, role: 'Sales Engineer' }, PREFS), 'not an engineering role at the right level');
  assert.equal(skipReason({ ...base, role: 'Solutions Engineer' }, PREFS), 'sales or support engineering');
  assert.equal(skipReason({ ...base, role: 'Office Coordinator' }, PREFS), 'not an engineering role');
  assert.equal(skipReason({ ...base, role: null }, PREFS), 'no role stated');
  assert.match(skipReason({ ...base, locations: ['Berlin'] }, PREFS), /location not workable/);
  assert.equal(skipReason({ ...base, locations: ['Remote - US'], remote: true }, PREFS), null);
  assert.match(skipReason({ ...base, locations: ['Remote - Europe'], remote: true }, PREFS), /location not workable/);
});

test('a board is read, filtered with reasons, stored, and a second run adds nothing', async () => {
  const store = openStore(':memory:');
  const fetchImpl = sourcesFetch();
  const first = await discoverBoards({ store, boards: ['greenhouse:acme', 'lever:globex', 'ashby:tahoma'], preferences: PREFS, fetch: fetchImpl, now: NOW });
  assert.equal(first.fetched, 7);
  assert.equal(first.created, 3, 'Staff SWE (SF), Engineering Manager (remote) and Founding Engineer');
  assert.deepEqual(first.skipped, { 'not an engineering role at the right level': 3, 'location not workable (on-site elsewhere or a non-US region)': 1 });
  assert.equal(first.errors.length, 0);
  assert.equal(store.listJobs().length, 3);
  const second = await discoverBoards({ store, boards: ['greenhouse:acme', 'lever:globex', 'ashby:tahoma'], preferences: PREFS, fetch: fetchImpl, now: NOW });
  assert.equal(second.created, 0);
  assert.equal(second.alreadyKnown, 3);
  const everything = await discoverBoards({ store: openStore(':memory:'), boards: ['greenhouse:acme'], preferences: PREFS, all: true, fetch: fetchImpl, now: NOW });
  assert.equal(everything.created, 4, '--all keeps what the filter would skip');
  const dry = await discoverBoards({ store: openStore(':memory:'), boards: ['greenhouse:acme'], preferences: PREFS, dryRun: true, fetch: fetchImpl, now: NOW });
  assert.deepEqual([dry.kept, dry.created], [1, 0]);
});

test('the same job from HN and a company board is one opportunity', async () => {
  const store = openStore(':memory:');
  await discover({ store, fetch: hnFetch({ comments: [{ ...COMMENTS.remote, text: 'Acme AI | Staff Software Engineer, Agent Platform | San Francisco | $200k<p>Apply: <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;acme&#x2F;jobs&#x2F;4461450008">link</a>' }] }), now: NOW });
  assert.equal(store.listJobs().length, 1);
  const board = await discoverBoards({ store, boards: ['greenhouse:acme'], preferences: PREFS, fetch: sourcesFetch(), now: NOW });
  assert.equal(board.merged, 1, 'matched by the Greenhouse job id');
  const jobs = store.listJobs({ company: 'acme' });
  assert.equal(jobs.length, 1);
  assert.equal(store.listSources(jobs[0].id).length, 2);
  assert.deepEqual(new Set(store.listSources(jobs[0].id).map((s) => s.source)), new Set(['hackernews', 'greenhouse']));
});

test('one failing source or board never stops the others', async () => {
  const store = openStore(':memory:');
  const fetchImpl = sourcesFetch({ fail: ['api.lever.co', 'remoteok.com'] });
  const summaries = await discoverSources({ store, source: 'all', preferences: PREFS, boards: ['greenhouse:acme', 'lever:globex'], fetch: fetchImpl, now: NOW, limit: null });
  const by = Object.fromEntries(summaries.map((s) => [s.source, s]));
  assert.ok(by.boards.created >= 1 && by.boards.errors[0].source === 'lever:globex');
  assert.equal(by.remoteok.errors.length, 1);
  assert.ok(by.weworkremotely.created >= 1);
  assert.ok(by['hn-jobs'].kept >= 1);
  assert.equal(by.hn.errors?.length, 1, 'the HN thread source reported its own failure (no HN fixture served here)');
  await assert.rejects(discoverSources({ store, source: 'bogus', preferences: PREFS }), /Unknown source/);
});

test('boards come from boards.yaml and from links already in the store', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-boards-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'boards.yaml'), 'boards:\n  - lever:globex\n  - greenhouse:acme\n');
  assert.deepEqual(loadBoardConfig(vault), { boards: ['lever:globex', 'greenhouse:acme'], derive: true });
  const store = openStore(':memory:');
  store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:1#0', company: 'A', role: 'Engineer', rawText: 'x', applicationUrls: ['https://jobs.ashbyhq.com/tahoma/abc?utm=1', 'https://boards.greenhouse.io/acme/jobs/9', 'https://boards.greenhouse.io/embed/job_app?for=initech&token=1', 'https://example.com/careers'], contactEmails: [] });
  assert.deepEqual(deriveBoards(store), ['ashby:tahoma', 'greenhouse:acme']);
  assert.deepEqual(resolveBoards({ vaultDir: vault, store }).sort(), ['ashby:tahoma', 'greenhouse:acme', 'lever:globex']);
  assert.deepEqual(resolveBoards({ vaultDir: vault, store, only: ['lever:one'] }), ['lever:one']);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'boards.yaml'), 'boards: [workday:x]\n');
  assert.throws(() => loadBoardConfig(vault), /must look like/);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'boards.yaml'), 'derive: false\nboards: [lever:globex]\n');
  assert.deepEqual(resolveBoards({ vaultDir: vault, store }), ['lever:globex']);
});

test('CLI: discover boards, hn-jobs and remote report what was kept and skipped', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-cli-sources-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const lines = [];
  const out = { log: (line) => lines.push(line) };
  const fetchImpl = sourcesFetch();
  assert.equal(await jobCli(['discover', 'boards', '--board', 'greenhouse:acme,lever:globex'], out, { vaultDir: vault, fetch: fetchImpl, now: NOW }), 0);
  assert.match(lines.join('\n'), /boards \(2 boards\): fetched 6, kept 2 \[skipped: .*not an engineering role at the right level/);
  lines.length = 0;
  assert.equal(await jobCli(['discover', 'remote', '--dry-run'], out, { vaultDir: vault, fetch: fetchImpl, now: NOW }), 0);
  assert.match(lines.join('\n'), /remoteok: fetched 2, kept 1.*dry run/);
  assert.equal(await jobCli(['discover', 'bogus'], out, { vaultDir: vault, fetch: fetchImpl }), 1);
});

test('CLI: "all" labels the HN thread line correctly', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-cli-all-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const lines = [];
  const both = async (url, init) => (String(url).includes('algolia') ? hnFetch()(url, init) : sourcesFetch()(url, init));
  assert.equal(await jobCli(['discover', 'all', '--board', 'greenhouse:acme'], { log: (line) => lines.push(line) }, { vaultDir: vault, fetch: both, now: NOW }), 0);
  assert.match(lines.join('\n'), /^hn: Ask HN: Who is hiring\? \(October 2026\): \d+ records; new \d+/m);
  assert.doesNotMatch(lines.join('\n'), /undefined|\[object Object\]/);
});

test('relevance: hardware and GTM roles are out unless the title says software; refilter cleans stored jobs', () => {
  const base = { locations: ['San Francisco'], remote: false };
  for (const role of ['Staff Mechanical Engineer', 'Principal Mechanisms Engineer, Optical', 'Senior Staff Structural Analyst - Spacecraft Engineering', 'Lead Hardware Design Engineer', 'Staff Electronics Engineer - Avionics']) {
    assert.equal(skipReason({ ...base, role }, PREFS), 'hardware or non-software engineering', role);
  }
  for (const role of ['Founding GTM Operator', 'Founding Technical GTM Lead', 'Head of GTM, AI Inference']) assert.equal(skipReason({ ...base, role }, PREFS), 'not an engineering role', role);
  for (const role of ['Embedded Software Engineer', 'Staff Firmware Engineer', 'Senior Hardware-in-the-loop Software Engineer', 'Autonomy Software Integration Engineer', 'Founding Engineer', 'Growth Engineer', 'Staff Software Engineer - Integrated Network Strategy']) assert.equal(skipReason({ ...base, role }, PREFS), null, role);

  const store = openStore(':memory:');
  const add = (n, source, role) => store.upsertSighting({ source, sourceKey: `${source}:${n}`, company: `Co${n}`, role, locations: ['San Francisco'], remote: false, rawText: role, applicationUrls: [], contactEmails: [], author: null }).job;
  const hardware = add(1, 'greenhouse', 'Staff Mechanical Engineer');
  const keep = add(2, 'greenhouse', 'Staff Software Engineer');
  const thread = add(3, 'hackernews', 'Staff Mechanical Engineer');
  const scored = add(4, 'lever', 'Principal Optical Engineer');
  store.saveScore(scored.id, { score: 20, confidence: 0.5, label: 'skip', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'staff-principal', projects: [], flags: [], degraded: false });
  const dry = refilterStored({ store, preferences: PREFS, dryRun: true });
  assert.deepEqual([dry.examined, dry.changed], [2, 1]);
  assert.equal(store.getJob(hardware.id).status, 'discovered', 'a dry run changes nothing');
  const real = refilterStored({ store, preferences: PREFS, now: NOW });
  assert.equal(real.skipped['hardware or non-software engineering'], 1);
  assert.equal(store.getJob(hardware.id).status, 'skipped');
  assert.ok(store.listEvents(hardware.id).some((event) => event.type === 'status' && event.detail.by === 'refilter'));
  for (const job of [keep, thread, scored]) assert.notEqual(store.getJob(job.id).status, 'skipped');
});

test('board descriptions yield no contact emails, so boilerplate addresses never make a board job look emailable', async () => {
  const noisy = { ...JSON.parse(JSON.stringify((await import('./fixtures/job-sources.js')).GREENHOUSE)) };
  noisy.jobs[0].content = noisy.jobs[0].content.replace('Remote-friendly', 'Contact hr@acme.example for accommodations. Remote-friendly');
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(noisy) });
  const [job] = await fetchBoard('greenhouse:acme', { fetch: fetchImpl });
  assert.match(job.description, /hr@acme\.example/, 'the text still says it');
  assert.deepEqual(job.contactEmails, []);
  // Aggregators that invite contact still do.
  const { sightings } = await discoverHnJobs({ fetch: sourcesFetch() });
  assert.deepEqual(sightings.find((entry) => entry.company.startsWith('Quill')).contactEmails, ['founders@quill.example']);
});

test('CLI reparse ignores board text but keeps what the poster invited', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-reparse-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const store = openStore((await import('../mcp/jobs/hunt/storage/store.js')).huntDbPath(vault));
  const board = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:acme:1', company: 'Acme', role: 'Engineer', rawText: 'Contact hr@acme.example for accommodations', applicationUrls: ['https://job-boards.greenhouse.io/acme/jobs/1'], contactEmails: ['hr@acme.example'], author: null }).job;
  store.upsertSighting({ source: 'hackernews', sourceKey: 'hackernews:5#0', company: 'Acme', role: 'Engineer', rawText: 'Acme | Engineer. Email jobs@acme.example', applicationUrls: ['https://job-boards.greenhouse.io/acme/jobs/1'], contactEmails: ['hr@acme.example', 'jobs@acme.example'], author: 'a' });
  store.close();
  const lines = [];
  assert.equal(await jobCli(['reparse'], { log: (line) => lines.push(line) }, { vaultDir: vault, now: NOW }), 0);
  const after = openStore((await import('../mcp/jobs/hunt/storage/store.js')).huntDbPath(vault));
  assert.deepEqual(after.getJob(board.id).contactEmails, ['jobs@acme.example']);
});

const PEAR = { apiVersion: '1', jobs: [
  { id: 'e1', title: 'Founding Engineer', department: 'Elo', location: 'San Francisco', isListed: true, isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/Pear-VC/e1', applyUrl: 'https://jobs.ashbyhq.com/Pear-VC/e1/application', descriptionHtml: '<p>Ad network SDK.</p>' },
  { id: 't1', title: 'Founding Engineer', department: 'Tanagram', location: 'San Francisco', isListed: true, isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/Pear-VC/t1', applyUrl: 'https://jobs.ashbyhq.com/Pear-VC/t1/application', descriptionHtml: '<p>Agents.</p>' },
  { id: 'x1', title: 'Staff Engineer — Shiplight AI', department: 'Engineering', location: 'San Francisco', isListed: true, isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/Pear-VC/x1', applyUrl: 'https://jobs.ashbyhq.com/Pear-VC/x1/application', descriptionHtml: '<p>QA.</p>' },
] };
const pearFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(PEAR) });

test('on a portfolio board the company is the employer, not the board, so different companies are never merged or blocked as one', async () => {
  const { PORTFOLIO_BOARD, employerFromTitle, companyFor } = await import('../mcp/jobs/hunt/sources/ats.js');
  for (const slug of ['Pear-VC', 'a16z', 'sequoia', 'founders-fund', 'techstars', 'acme-ventures', 'foo-capital']) assert.ok(PORTFOLIO_BOARD.test(slug), slug);
  for (const slug of ['anthropic', 'palantir', 'ramp', 'stripe']) assert.equal(PORTFOLIO_BOARD.test(slug), false, `${slug} is an ordinary company board`);
  assert.equal(PORTFOLIO_BOARD.test('tahoma'), false);
  assert.equal(PORTFOLIO_BOARD.test('anthropic'), false);
  assert.equal(employerFromTitle('Staff Engineer — Shiplight AI'), 'Shiplight AI');
  assert.equal(employerFromTitle('Founding Engineer'), null);
  assert.equal(companyFor('Pear-VC', { department: 'Engineering', title: 'Staff Engineer - Shiplight AI' }, 'Pear VC'), 'Shiplight AI', 'a generic department falls back to the title');
  assert.equal(companyFor('tahoma', { department: 'Engineering' }, 'Tahoma'), 'Tahoma', 'an ordinary company board keeps its name');
  const sightings = await fetchBoard('ashby:Pear-VC', { fetch: pearFetch });
  assert.deepEqual(sightings.map((s) => s.company), ['Elo', 'Tanagram', 'Shiplight AI']);
  const store = openStore(':memory:');
  const result = await discoverBoards({ store, boards: ['ashby:Pear-VC'], preferences: PREFS, fetch: pearFetch, now: NOW });
  assert.equal(result.created, 3, 'two "Founding Engineer" roles at different companies are two opportunities');
  assert.deepEqual(store.listJobs().map((job) => job.company).sort(), ['Elo', 'Shiplight AI', 'Tanagram']);
});

test('setCompany moves a job to its real employer, including its company+role identity', () => {
  const store = openStore(':memory:');
  const a = store.upsertSighting({ source: 'ashby', sourceKey: 'ashby:Pear-VC:1', sourceThread: 'Pear-VC', company: 'Pear VC', role: 'Founding Engineer', rawText: 'x', applicationUrls: [], contactEmails: [], author: null }).job;
  store.setCompany(a.id, 'Elo', NOW);
  assert.equal(store.getJob(a.id).company, 'Elo');
  assert.ok(store.listEvents(a.id).some((event) => event.type === 'company_corrected' && event.detail.to === 'Elo'));
  const again = store.upsertSighting({ source: 'greenhouse', sourceKey: 'greenhouse:elo:9', company: 'Elo, Inc.', role: 'Founding Engineer', rawText: 'x', applicationUrls: [], contactEmails: [], author: null });
  assert.equal(again.created, false, 'the same role at Elo from another source now merges with it');
  assert.equal(again.job.id, a.id);
  const other = store.upsertSighting({ source: 'ashby', sourceKey: 'ashby:Pear-VC:2', sourceThread: 'Pear-VC', company: 'Pear VC', role: 'Founding Engineer', rawText: 'x', applicationUrls: [], contactEmails: [], author: null });
  assert.equal(other.created, true, 'and no longer swallows another company\'s role of the same name');
});

test('CLI recompany re-reads the portfolio boards and corrects stored jobs by their ATS id', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-recompany-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  const { huntDbPath } = await import('../mcp/jobs/hunt/storage/store.js');
  const store = openStore(huntDbPath(vault));
  const mk = (id, role) => store.upsertSighting({ source: 'ashby', sourceKey: `ashby:Pear-VC:${id}`, sourceThread: 'Pear-VC', company: 'Pear VC', role, rawText: 'x', applicationUrls: [`https://jobs.ashbyhq.com/Pear-VC/${id}/application`], contactEmails: [], author: null }).job;
  const elo = mk('e1', 'Founding Engineer');
  const shiplight = mk('x1', 'Staff Engineer — Shiplight AI');
  store.close();
  const lines = [];
  assert.equal(await jobCli(['recompany', '--dry-run'], { log: (line) => lines.push(line) }, { vaultDir: vault, fetch: pearFetch, now: NOW }), 0);
  assert.match(lines.join('\n'), /2 job\(s\) would be corrected across 1 portfolio board/);
  assert.equal(openStore(huntDbPath(vault)).getJob(elo.id).company, 'Pear VC', 'a dry run changes nothing');
  await jobCli(['recompany'], { log: () => {} }, { vaultDir: vault, fetch: pearFetch, now: NOW });
  const after = openStore(huntDbPath(vault));
  assert.deepEqual([after.getJob(elo.id).company, after.getJob(shiplight.id).company], ['Elo', 'Shiplight AI']);
});
