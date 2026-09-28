import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../server/mcp/client.js';
import { toolResult } from '../server/mcp/mcp-tools.js';
import { recordFile } from '../mcp/jobs/ledger.js';
import { startJobBoards } from './fixtures/job-boards.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp', 'jobs', 'server.js');

// Real Chromium: Playwright's own build, or the image's preinstalled one.
async function browserPath() {
  const { chromium } = await import('playwright');
  if (fs.existsSync(chromium.executablePath())) return null;
  for (const dir of fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').filter((name) => /^chromium-\d+$/.test(name)) : []) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join('/opt/pw-browsers', dir, sub);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No Chromium found: run npx playwright install chromium');
}

let boards;
let executable;
before(async () => { boards = await startJobBoards(); executable = await browserPath(); });
after(() => boards.close());

const PROFILE = ({ submit = true, max = 5 } = {}) => `---
first_name: Sam
last_name: Rivera
email: sam@example.com
phone: "+1 503 555 0100"
location: Portland, OR
current_company: Initech
linkedin: https://www.linkedin.com/in/sam-rivera-example
resume: resume.pdf
boards: [greenhouse:acme, lever:globex]
submit: ${submit}
max_applications_per_day: ${max}
answers:
  gender: Decline to self identify
---
I build reliable systems.
`;

async function jobs(t, profile = PROFILE()) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-jobs-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'profile.md'), profile);
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.pdf'), '%PDF-1.4 resume of Sam Rivera');
  const client = new McpClient({
    name: 'jobs', command: process.execPath, args: [SERVER, '--vault', vault], cwd: vault, timeoutMs: 90_000,
    env: { ...boards.env, JOBS_SUBMIT_TIMEOUT_MS: '3000', ...(executable ? { JOBS_BROWSER_PATH: executable } : {}) },
  });
  await client.connect();
  t.after(() => { client.close(); fs.rmSync(vault, { recursive: true, force: true }); });
  const call = async (name, args = {}) => toolResult(await client.callTool(name, args));
  const submitted = (pathPrefix) => boards.submissions.filter((item) => item.path.startsWith(pathPrefix));
  return { vault, client, call, submitted };
}

test('search matches titles and locations across Greenhouse and Lever, with questions', async (t) => {
  const { call, client } = await jobs(t);
  assert.deepEqual((await client.listTools()).map((tool) => tool.name).sort(), ['apply', 'list_applications', 'search_jobs', 'skip_job']);
  const found = await call('search_jobs', { keywords: ['engineer'], locations: ['Portland'], remote: true });
  assert.deepEqual(found.results.map((job) => job.job_id).sort(), ['greenhouse:acme:101', 'greenhouse:acme:103', 'lever:globex:abc-1']);
  const senior = found.results.find((job) => job.job_id === 'greenhouse:acme:101');
  assert.equal(senior.company, 'Acme Corp');
  assert.equal(senior.description, 'Build & ship things.');
  assert.ok(senior.questions.some((question) => question.name === 'question_3' && question.required && question.options.includes('Yes')));
  const lever = found.results.find((job) => job.job_id === 'lever:globex:abc-1');
  assert.match(lever.salary, /180000-220000 USD/);
  assert.equal(lever.questions, null, 'Lever questions are discovered on the form');
  const missing = await call('search_jobs', { boards: ['greenhouse:nope'] });
  assert.match(missing.errors[0].error, /not found/);
  await assert.rejects(() => call('search_jobs', { boards: ['https://evil.example'] }), /must look like/);
});

test('apply fills identity from the vault, stops for unanswered questions, then submits exactly once', async (t) => {
  const { call, vault, submitted } = await jobs(t);
  const first = await call('apply', { job_id: 'greenhouse:acme:101' });
  assert.equal(first.status, 'needs_answers');
  assert.deepEqual(first.missing_questions.map((question) => question.name).sort(), ['question_2', 'question_3']);
  assert.equal(submitted('/gh-board/acme/jobs/101').length, 0, 'nothing submitted');
  const pending = await call('search_jobs', { keywords: ['senior'] });
  assert.equal(pending.results[0].application_status, 'needs_answers');

  const applied = await call('apply', { job_id: 'greenhouse:acme:101', cover_letter: 'Acme builds what I care about.', answers: {
    question_2: 'Your mission.', question_3: 'Yes',
    // The model can change none of these.
    email: 'attacker@example.com', first_name: 'Mallory', resume: '/etc/passwd', gender: 'Male',
  } });
  assert.equal(applied.status, 'applied', applied.message);
  const [submission] = submitted('/gh-board/acme/jobs/101');
  for (const expected of ['sam@example.com', 'Sam', 'Rivera', '+1 503 555 0100', 'Your mission.', 'https://www.linkedin.com/in/sam-rivera-example', 'Acme builds what I care about.', 'resume.pdf', '%PDF-1.4 resume of Sam Rivera']) {
    assert.ok(submission.body.includes(expected), expected);
  }
  assert.ok(!submission.body.includes('attacker@example.com') && !submission.body.includes('Mallory'));
  assert.match(submission.body, /name="question_3"\r\n\r\n1\r\n/);
  assert.match(submission.body, /name="gender"\r\n\r\nd\r\n/, 'demographics only from the owner\'s own profile answers');

  const record = fs.readFileSync(recordFile(vault, 'greenhouse:acme:101'), 'utf8');
  assert.match(record, /status: applied/);
  assert.match(record, /Acme builds what I care about\./);
  assert.ok(fs.existsSync(path.join(vault, applied.screenshot)));

  const again = await call('apply', { job_id: 'greenhouse:acme:101', answers: { question_2: 'x', question_3: 'Yes' } });
  assert.equal(again.status, 'already_recorded');
  assert.equal(submitted('/gh-board/acme/jobs/101').length, 1, 'never submitted twice');
  const later = await call('search_jobs', { keywords: ['senior'] });
  assert.deepEqual(later.results, [], 'applied jobs leave the results');
  const listed = await call('list_applications', { status: 'applied' });
  assert.deepEqual(listed.applications.map((item) => [item.job_id, item.title]), [['greenhouse:acme:101', 'Senior Software Engineer']]);
});

test('a CAPTCHA hands the application to the owner and is never retried', async (t) => {
  const { call, submitted } = await jobs(t);
  const result = await call('apply', { job_id: 'greenhouse:acme:103', answers: { question_2: 'Remote work.', question_3: 'Yes' } });
  assert.equal(result.status, 'needs_owner', result.message);
  const retry = await call('apply', { job_id: 'greenhouse:acme:103', answers: { question_2: 'Remote work.', question_3: 'Yes' } });
  assert.equal(retry.status, 'already_recorded');
  assert.equal(submitted('/gh-board/acme/jobs/103').length, 1);
});

test('Lever questions are discovered on the form; dry runs fill without submitting', async (t) => {
  const dry = await jobs(t, PROFILE({ submit: false }));
  const needs = await dry.call('apply', { job_id: 'lever:globex:abc-1' });
  assert.equal(needs.status, 'needs_answers');
  assert.deepEqual(needs.missing_questions.map((question) => [question.name, question.label]), [['cards[c1][field0]', 'What is the best system you have built? *']]);
  const before = dry.submitted('/lever-jobs').length;
  const rehearsal = await dry.call('apply', { job_id: 'lever:globex:abc-1', answers: { 'cards[c1][field0]': 'A payments ledger.' } });
  assert.equal(rehearsal.status, 'dry_run');
  assert.equal(dry.submitted('/lever-jobs').length, before, 'dry run submits nothing');
  assert.ok(fs.existsSync(path.join(dry.vault, rehearsal.screenshot)));

  const live = await jobs(t);
  const applied = await live.call('apply', { job_id: 'lever:globex:abc-1', answers: { 'cards[c1][field0]': 'A payments ledger.' } });
  assert.equal(applied.status, 'applied', applied.message);
  const body = live.submitted('/lever-jobs').at(-1).body;
  for (const expected of ['Sam Rivera', 'sam@example.com', 'Initech', 'https://www.linkedin.com/in/sam-rivera-example', 'A payments ledger.', 'I build reliable systems.']) assert.ok(body.includes(expected), expected);
});

test('the daily limit, skipping and job ids are enforced by the server', async (t) => {
  const { call, submitted } = await jobs(t, PROFILE({ max: 1 }));
  assert.equal((await call('apply', { job_id: 'lever:globex:abc-1', answers: { 'cards[c1][field0]': 'x' } })).status, 'applied');
  const count = submitted('/gh-board/acme/jobs/101').length;
  const limited = await call('apply', { job_id: 'greenhouse:acme:101', answers: { question_2: 'x', question_3: 'Yes' } });
  assert.equal(limited.status, 'daily_limit');
  assert.equal(submitted('/gh-board/acme/jobs/101').length, count);
  assert.equal((await call('skip_job', { job_id: 'greenhouse:acme:104', reason: 'Too far' })).status, 'skipped');
  assert.ok(!(await call('search_jobs', { keywords: ['engineer'] })).results.some((job) => job.job_id === 'greenhouse:acme:104'));
  await assert.rejects(() => call('apply', { job_id: 'https://evil.example/apply' }), /job_id must be/);
  assert.equal((await call('apply', { job_id: 'greenhouse:acme:999' })).status, 'daily_limit');
});

test('a missing profile or resume is reported, not guessed', async (t) => {
  const { call, vault } = await jobs(t, PROFILE().replace('resume: resume.pdf', 'resume: ../../etc/passwd'));
  await assert.rejects(() => call('apply', { job_id: 'greenhouse:acme:101' }), /resume must be a file inside job-hunt/);
  fs.rmSync(path.join(vault, 'job-hunt', 'profile.md'));
  await assert.rejects(() => call('search_jobs', {}), /No applicant profile/);
});

test('the example vault declares exactly the server\'s tools, and its profile loads', async (t) => {
  const { loadMcpConfig } = await import('../server/mcp/config.js');
  const { loadProfile, requireApplicant } = await import('../mcp/jobs/profile.js');
  const example = path.join(ROOT, 'examples', 'vault');
  const config = loadMcpConfig(example);
  assert.equal(config.error, null);
  const { client } = await jobs(t);
  assert.deepEqual(config.servers[0].tools.map((tool) => tool.name).sort(), (await client.listTools()).map((tool) => tool.name).sort());
  const profile = loadProfile(example);
  assert.equal(profile.submit, false, 'the example never submits');
  assert.throws(() => requireApplicant(profile), /resume file resume.pdf was not found/);
});

test('through U2OS: the planner searches, applying waits for approval, then submits', async (t) => {
  const { getDb, closeAllForTests } = await import('../server/db/connection.js');
  const { EventBus } = await import('../server/events/event-bus.js');
  const { PolicyEngine } = await import('../server/policy/policy-engine.js');
  const { createToolRegistry } = await import('../server/tools/register-all.js');
  const { Agent } = await import('../server/agent/agent.js');
  const { startMcpServers, stopMcpServers } = await import('../server/mcp/mcp-tools.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-jobs-home-'));
  process.env.U2OS_HOME = home;
  const vault = path.join(home, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'profile.md'), PROFILE());
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.pdf'), '%PDF-1.4');
  const env = { ...boards.env, JOBS_SUBMIT_TIMEOUT_MS: '3000', ...(executable ? { JOBS_BROWSER_PATH: executable } : {}) };
  fs.writeFileSync(path.join(vault, 'mcp.yaml'), fs.readFileSync(path.join(ROOT, 'examples', 'vault', 'mcp.yaml'), 'utf8')
    .replace('    timeout_seconds: 180', `    timeout_seconds: 180\n    env: ${JSON.stringify(env)}`));
  t.after(async () => { await stopMcpServers(); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true }); });

  const toolRegistry = createToolRegistry();
  const status = await startMcpServers({ toolRegistry });
  assert.equal(status.servers[0].state, 'running', status.servers[0].error);
  let calls = 0;
  const agent = new Agent({
    modelProvider: { id: 'fixture', destination: 'configured_remote_model', plan: async (context) => {
      calls += 1;
      if (calls === 1) return { reasoning_summary: 'Search first', continue: true, actions: [{ tool: 'jobs.search_jobs', arguments: { keywords: ['staff'] } }] };
      const results = context.observations[0].items[0].data.results;
      return { reasoning_summary: 'Strong match', actions: [{ tool: 'jobs.apply', arguments: { job_id: results[0].job_id, answers: { 'cards[c1][field0]': 'A ledger.' } } }] };
    } },
    policyEngine: new PolicyEngine(), toolRegistry, eventBus: new EventBus(getDb()),
  });
  const result = await agent.handleMessage({ text: 'Find me jobs', actorId: 'owner' });
  assert.deepEqual(result.actions.map((action) => [action.tool, action.status]), [['jobs.search_jobs', 'executed'], ['jobs.apply', 'pending']]);
  assert.equal(boards.submissions.filter((item) => item.path.startsWith('/lever-jobs') && item.body.includes('A ledger.')).length, 0, 'nothing before approval');
  const approved = await agent.approveAction(result.actions[1].id, 'owner');
  assert.equal(approved.status, 'executed');
  assert.equal(approved.result.status, 'applied', approved.result.message);
  assert.equal(boards.submissions.filter((item) => item.path.startsWith('/lever-jobs') && item.body.includes('A ledger.')).length, 1);
});
