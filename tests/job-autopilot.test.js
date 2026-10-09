import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { Autopilot, TOOLS } from '../server/jobhunt/autopilot.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { stageAttachment } from '../server/tools/email-attachments.js';
import { RESUME, fakeLlm } from './fixtures/job-hunt-candidate.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const BODY = 'Hi,\n\nI saw your post for the Founding Engineer role. Deterministic orchestration around agents is what I build with U2OS, a personal agent platform with MCP and approval, and I ran engineering as CTO of D. Harris Tours.\n\nMy tailored resume is attached.\n\nBest,\nPat Example\n';
const approve = { decision: 'approve', confidence: 0.9, concerns: [], notes: 'ok' };

function world({ mode = 'live', extraConfig = '', jobs = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-ap-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'facts.md'), '## D. Harris Tours\n- Grew the fleet from 2 to 14 vehicles.\n## Project: U2OS\nPersonal agent platform with deterministic orchestration, MCP, and approval.\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), `enabled: true\nmode: ${mode}\n${extraConfig}`);
  const pdf = path.join(dir, 'resume.pdf');
  fs.writeFileSync(pdf, '%PDF resume');
  const staged = stageAttachment(vault, pdf, { name: 'Pat_Resume.pdf' });
  const store = openStore(huntDbPath(vault));
  const made = [];
  for (let i = 0; i < jobs; i += 1) {
    const company = `Tahoma${i}`;
    const posting = `${company} AI | Founding Engineer | Remote (US)\nWe build deterministic orchestration around agents. Email founder@tahoma${i}.io with your resume.`;
    const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${i}#0`, company, role: 'Founding Engineer', locations: ['Remote (US)'], remote: true, technologies: [], description: posting, rawText: posting, applicationUrls: [], contactEmails: [`founder@tahoma${i}.io`], author: 'f' });
    store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: ['Direct overlap'], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false, model: 'm' });
    const write = (name, content) => { const file = path.join(dir, `${i}-${name}`); fs.writeFileSync(file, content); return file; };
    store.addArtifact(job.id, 'resume_txt', write('resume.txt', 'Pat Example\nCTO at D. Harris Tours\n'));
    store.addArtifact(job.id, 'resume_pdf', pdf);
    store.addArtifact(job.id, 'email_json', write('email.json', JSON.stringify({ to: `founder@tahoma${i}.io`, subject: `Founding Engineer at ${company}`, text: BODY, attachments: [staged.ref], needsInput: [] })));
    made.push(store.getJob(job.id));
  }
  return { dir, vault, store, jobs: made, store2: () => openStore(huntDbPath(vault)) };
}

function pilot(w, { reply = approve, tools = { 'jobs.send_application': true, 'jobs.submit_application': true }, actions = [], deps = {} } = {}) {
  const proposals = [];
  const f = fakeLlm(reply);
  const agent = {
    evaluateAndMaybeExecute: async (proposal) => { proposals.push(proposal); return { id: `act_${proposals.length}`, status: 'executed', result: { status: 'sent' } }; },
    actionEvaluator: { resolve: (name) => ({ name }), evaluate: ({ tool }) => ({ requiresApproval: tool.name !== 'jobs.send_application' }) },
  };
  const toolRegistry = { get: (name) => { if (!tools[name]) throw new Error('unknown'); return { name }; }, isHidden: () => false };
  const autopilot = new Autopilot({
    agent, toolRegistry, vaultDir: w.vault, clock: () => NOW,
    deps: { createLlm: () => createLlm([f.provider]), discoverSources: async () => [{ source: 'hackernews', created: 2, errors: [] }], scoreJobs: async () => ({ scored: 0, screened: 0, errors: [] }), getAction: (id) => actions.find((a) => a.id === id) ?? { id, status: 'executed' }, ...deps },
  });
  return { autopilot, proposals, llm: f };
}

test('disabled does nothing; the default configuration never acts', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.vault, 'job-hunt', 'autopilot.yaml'), 'enabled: false\nmode: live\n');
  const { autopilot, proposals } = pilot(w);
  assert.deepEqual(await autopilot.runCycle({ now: NOW }), { skipped: 'disabled' });
  assert.equal(proposals.length, 0);
  fs.rmSync(path.join(w.vault, 'job-hunt', 'autopilot.yaml'));
  assert.deepEqual(await autopilot.runCycle({ now: NOW }), { skipped: 'disabled' });
});

test('dry run: reviews the prepared job, records what it would do exactly once, and calls no tool', async () => {
  const w = world({ mode: 'dry_run' });
  const { autopilot, proposals } = pilot(w);
  const first = await autopilot.runCycle({ now: NOW });
  assert.equal(first.mode, 'dry_run');
  assert.equal(first.steps.review.reviewed, 1);
  assert.equal(first.actions.length, 1);
  assert.match(first.actions[0].result, /dry_run: would act/);
  assert.equal(first.actions[0].to, 'founder@tahoma0.io');
  assert.equal(proposals.length, 0);
  const second = await autopilot.runCycle({ now: NOW });
  assert.equal(second.actions.length, 0, 'recorded once per approval');
  assert.equal(second.steps.review.reviewed, 0, 'unchanged content is not reviewed twice');
  const store = w.store2();
  assert.equal(store.listEvents(w.jobs[0].id).filter((event) => event.type === 'autopilot_would_act').length, 1);
  assert.equal(store.getJob(w.jobs[0].id).status, 'scored');
  store.close();
});

test('live: proposes only the narrow tool with only the job id, through the gate, once per approval', async () => {
  const w = world({ mode: 'live' });
  const { autopilot, proposals } = pilot(w);
  const report = await autopilot.runCycle({ now: NOW });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].tool, TOOLS.email);
  assert.deepEqual(proposals[0].arguments, { job_id: w.jobs[0].id }, 'nothing but the job id');
  assert.equal(proposals[0].requestedBy, 'job-autopilot');
  assert.match(report.actions[0].result, /^done:/);
  await autopilot.runCycle({ now: NOW });
  assert.equal(proposals.length, 1, 'not proposed again for the same approval');
});

test('a rejection is reported for the owner and not re-reviewed until the content changes; a pending approval is not proposed twice', async () => {
  const w = world({ mode: 'live' });
  const { autopilot, proposals, llm } = pilot(w, { reply: { decision: 'reject', confidence: 0.9, concerns: [{ severity: 'blocking', text: 'The email is vague.' }], notes: 'Too generic.' } });
  const first = await autopilot.runCycle({ now: NOW });
  assert.equal(proposals.length, 0);
  assert.match(first.needsYou[0].why, /review rejected \(email\)/);
  await autopilot.runCycle({ now: NOW });
  assert.equal(llm.calls.length, 1, 'the same content is not reviewed again');
  const file = w.store.getArtifacts(w.jobs[0].id).email_json.path;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Founding Engineer at', 'Founding Engineer role at'));
  await autopilot.runCycle({ now: NOW });
  assert.equal(llm.calls.length, 2, 'changed content is reviewed again');

  const p = world({ mode: 'live' });
  const pending = [{ id: 'act_1', status: 'pending' }];
  const second = pilot(p, { actions: pending, deps: {} });
  second.autopilot.agent.evaluateAndMaybeExecute = async (proposal) => { second.proposals.push(proposal); return { id: 'act_1', status: 'pending' }; };
  await second.autopilot.runCycle({ now: NOW });
  await second.autopilot.runCycle({ now: NOW });
  assert.equal(second.proposals.length, 1, 'a proposal still waiting for approval is not duplicated');
});

test('the tool server not being set up is reported, never worked around', async () => {
  const w = world({ mode: 'live' });
  const { autopilot, proposals } = pilot(w, { tools: {} });
  const report = await autopilot.runCycle({ now: NOW });
  assert.equal(proposals.length, 0);
  assert.match(report.needsYou[0].why, /jobs\.send_application is not available/);
  assert.deepEqual(autopilot.policyStatus().email, { tool: 'jobs.send_application', available: false, autonomous: null });
});

test('policy status tells the owner what live means: which tools run without approval', () => {
  const w = world();
  const { autopilot } = pilot(w);
  assert.deepEqual(autopilot.policyStatus(), { email: { tool: 'jobs.send_application', available: true, autonomous: true }, form: { tool: 'jobs.submit_application', available: true, autonomous: false } });
});

test('a failing step never stops the others, and the per-cycle limits hold', async () => {
  const w = world({ mode: 'live', jobs: 5, extraConfig: 'per_cycle:\n  act: 2\n  prepare: 3\n' });
  const { autopilot, proposals } = pilot(w, { deps: { discoverSources: async () => { throw new Error('network down'); } } });
  const first = await autopilot.runCycle({ now: NOW });
  assert.ok(first.errors.some((entry) => /discover: network down/.test(entry)), 'the failure is reported');
  assert.equal(first.steps.review.reviewed, 3, 'review is bounded per cycle, and still ran after discover failed');
  assert.equal(first.steps.act.acted, 2, 'acting is bounded per cycle');
  assert.equal(proposals.length, 2);
  const second = await autopilot.runCycle({ now: NOW });
  assert.equal(second.steps.review.reviewed, 2, 'the remaining two are reviewed next cycle');
  assert.equal(second.steps.act.acted, 2);
  const third = await autopilot.runCycle({ now: NOW });
  assert.equal(proposals.length, 5, 'every approved job acted on exactly once across cycles');
  assert.equal(third.steps.act.acted, 1);
  assert.equal(new Set(proposals.map((proposal) => proposal.arguments.job_id)).size, 5);
});

test('prepare: scored jobs without materials are prepared, form jobs are planned, and a failing job is parked, not retried forever', async () => {
  const w = world({ mode: 'live', jobs: 0, extraConfig: 'per_cycle:\n  prepare: 10\nroutes:\n  form: true\n' });
  const make = (n, extra) => { const { job } = w.store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:p${n}#0`, company: `Prep${n}`, role: 'Founding Engineer', rawText: 'Prep', applicationUrls: [], contactEmails: [], author: null, ...extra }); w.store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false }); return w.store.getJob(job.id); };
  const email = make(1, { contactEmails: ['a@prep1.io'] });
  const form = make(2, { applicationUrls: ['https://jobs.ashbyhq.com/prep2/1/application'] });
  const broken = make(3, { contactEmails: ['a@prep3.io'] });
  make(4, {});
  const calls = [];
  const deps = {
    generateMaterials: async ({ job }) => { calls.push(`materials:${job.company}`); if (job.company === 'Prep3') throw new Error('renderer crashed'); const file = path.join(w.dir, `${job.id}.pdf`); fs.writeFileSync(file, '%PDF'); w.store.addArtifact(job.id, 'resume_pdf', file); },
    planApplication: async ({ job }) => { calls.push(`plan:${job.company}`); return { status: 'needs_input', plan: { needs: ['needs_answer:work_authorization_us'], blockers: [] } }; },
  };
  const { autopilot } = pilot(w, { deps });
  const report = await autopilot.runCycle({ now: NOW });
  assert.deepEqual(calls.sort(), ['materials:Prep1', 'materials:Prep2', 'materials:Prep3', 'plan:Prep2'].sort());
  assert.ok(report.needsYou.some((entry) => /Prep2/.test(entry.job) && /work_authorization_us/.test(entry.why)));
  assert.ok(report.errors.some((entry) => /prepare Prep3/.test(entry)));
  assert.equal(w.store.getJob(broken.id).status, 'error', 'parked so it is not retried every cycle');
  assert.ok(!calls.some((entry) => entry.includes('Prep4')), 'a job with no email and no form has nothing to prepare');
  assert.equal(w.store.getJob(email.id).status, 'scored');
  assert.equal(form.id.length > 0, true);
});

test('only one cycle runs at a time, and the timer starts a cycle when the interval has passed', async () => {
  const w = world({ mode: 'dry_run' });
  let release;
  let calls = 0;
  const { autopilot } = pilot(w, { deps: { discoverSources: () => (calls++ === 0 ? new Promise((resolve) => { release = () => resolve([]); }) : Promise.resolve([])) } });
  const first = autopilot.runCycle({ now: NOW });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await autopilot.runCycle({ now: NOW }), { skipped: 'a cycle is already running' });
  release();
  await first;

  const ticks = [];
  let time = NOW.getTime();
  const timed = pilot(w).autopilot;
  timed.clock = () => new Date(time);
  timed.setIntervalFn = (fn) => { ticks.push(fn); return { unref() {} }; };
  timed.runCycle = async () => { timed.running = true; timed.lastFinished = time; timed.running = false; ticks.ran = (ticks.ran ?? 0) + 1; return {}; };
  timed.start();
  timed.start();
  assert.equal(ticks.length, 1, 'start is idempotent');
  ticks[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ticks.ran, 1);
  ticks[0]();
  assert.equal(ticks.ran, 1, 'not again before the interval (300s)');
  time += 301_000;
  ticks[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ticks.ran, 2);
  timed.stop();
});

import { setupAutopilot, revokeAutonomy } from '../mcp/jobs/hunt/autopilot/setup.js';
import { setAutopilotSwitches, loadAutopilotConfig } from '../mcp/jobs/hunt/autopilot/config.js';
import { main as jobCli } from '../server/jobhunt/cli.js';
import yaml from 'js-yaml';

test('setup registers only the two narrow tools, grants autonomy only when asked, merges without clobbering, and can be revoked', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-setup-'));
  fs.writeFileSync(path.join(vault, 'mcp.yaml'), 'servers:\n  other:\n    command: node\n    args: [x.js]\n');
  fs.writeFileSync(path.join(vault, 'policies.yaml'), 'email:\n  send: confirm\njobs:\n  apply: confirm\n');
  const first = setupAutopilot(vault);
  assert.equal(first.length, 1, 'tools registered; no autonomy yet');
  const mcp = yaml.load(fs.readFileSync(path.join(vault, 'mcp.yaml'), 'utf8'));
  assert.ok(mcp.servers.other, 'existing servers are kept');
  assert.deepEqual(Object.keys(mcp.servers.jobs.tools).sort(), ['send_application', 'submit_application'], 'the old apply tool is not exposed');
  assert.equal(yaml.load(fs.readFileSync(path.join(vault, 'policies.yaml'), 'utf8')).jobs.send_application, undefined);
  assert.equal(setupAutopilot(vault).length, 0, 'idempotent');
  const granted = setupAutopilot(vault, { autonomous: true });
  assert.equal(granted.length, 1);
  const policies = yaml.load(fs.readFileSync(path.join(vault, 'policies.yaml'), 'utf8'));
  assert.deepEqual([policies.jobs.send_application, policies.jobs.submit_application, policies.jobs.apply, policies.email.send], ['autonomous', 'autonomous', 'confirm', 'confirm'], 'nothing else is loosened');
  assert.equal(setupAutopilot(vault, { autonomous: true }).length, 0);
  assert.equal(revokeAutonomy(vault), true);
  assert.equal(yaml.load(fs.readFileSync(path.join(vault, 'policies.yaml'), 'utf8')).jobs.send_application, 'confirm');
});

test('the switches change only enabled and mode and keep the owner\'s other settings', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-switch-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), 'limits:\n  emails_per_day: 3\nblocklist:\n  companies: [acme]\n');
  const config = setAutopilotSwitches(vault, { enabled: true, mode: 'live' });
  assert.deepEqual([config.enabled, config.mode, config.limits.emails_per_day, config.blocklist.companies], [true, 'live', 3, ['acme']]);
  assert.throws(() => setAutopilotSwitches(vault, { mode: 'yolo' }), /dry_run or live/);
  assert.throws(() => setAutopilotSwitches(vault, { enabled: 'yes' }), /true or false/);
  assert.equal(loadAutopilotConfig(vault).mode, 'live');
});

test('CLI: autopilot on, live, dry-run, off and status', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-cli-ap-'));
  fs.mkdirSync(path.join(vault, 'job-hunt'));
  const lines = [];
  const out = { log: (line) => lines.push(line) };
  assert.equal(await jobCli(['autopilot', 'on'], out, { vaultDir: vault }), 0);
  assert.match(lines.at(-1), /on, dry run \(it sends nothing\)/);
  await jobCli(['autopilot', 'live'], out, { vaultDir: vault });
  assert.match(lines.at(-1), /LIVE \(it sends and submits\)/);
  await jobCli(['autopilot', 'dry-run'], out, { vaultDir: vault });
  assert.match(lines.at(-1), /dry run/);
  await jobCli(['autopilot', 'off'], out, { vaultDir: vault });
  assert.match(lines.at(-1), /off, dry run/);
  await jobCli(['autopilot', 'setup', '--autonomous'], out, { vaultDir: vault });
  assert.ok(lines.some((line) => /policies\.yaml/.test(line)));
  await jobCli(['autopilot', 'status'], out, { vaultDir: vault });
  assert.match(lines.at(-1) + lines.join('\n'), /Autopilot: off/);
});

test('the forms route is off by default: form-only jobs are reported, never planned, reviewed or acted on', async () => {
  const w = world({ mode: 'live', jobs: 0 });
  const { job } = w.store.upsertSighting({ source: 'ashby', sourceKey: 'ashby:x:1', company: 'FormCo', role: 'Founding Engineer', rawText: 'FormCo', applicationUrls: ['https://jobs.ashbyhq.com/formco/1/application'], contactEmails: [], author: null });
  w.store.saveScore(job.id, { score: 90, confidence: 0.9, label: 'exceptional', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'ai-agent-systems', projects: [], flags: [], degraded: false });
  const calls = [];
  const { autopilot, proposals } = pilot(w, { deps: { generateMaterials: async () => { calls.push('materials'); }, planApplication: async () => { calls.push('plan'); return { status: 'planned', plan: {} }; } } });
  const report = await autopilot.runCycle({ now: NOW });
  assert.deepEqual(calls, [], 'nothing is prepared for a form-only job while the route is off');
  assert.equal(report.steps.prepare.formOnlyWaiting, 1, 'it is counted, not worked, and does not use up the preparation budget');
  assert.equal(proposals.length, 0);
  assert.equal(loadAutopilotConfig(w.vault).routes.form, false);
  fs.writeFileSync(path.join(w.vault, 'job-hunt', 'autopilot.yaml'), 'enabled: true\nmode: live\nroutes:\n  form: maybe\n');
  await assert.rejects(autopilot.runCycle({ now: NOW }), /routes\.form must be true or false/);
});

test('changing the threshold re-opens a rejected review instead of leaving it stale', async () => {
  const w = world({ mode: 'dry_run' });
  fs.writeFileSync(path.join(w.vault, 'job-hunt', 'preferences.yaml'), 'minimum_score: 95\n');
  const { autopilot, llm } = pilot(w);
  const first = await autopilot.runCycle({ now: NOW });
  assert.match(first.needsYou[0].why, /score_meets_threshold/);
  assert.equal(first.actions.length, 0);
  await autopilot.runCycle({ now: NOW });
  assert.equal(llm.calls.length, 0, 'still rejected by the checks; not asked again while nothing changed');
  fs.writeFileSync(path.join(w.vault, 'job-hunt', 'preferences.yaml'), 'minimum_score: 70\n');
  const third = await autopilot.runCycle({ now: NOW });
  assert.equal(third.steps.review.reviewed, 1, 'a lowered threshold re-reviews');
  assert.equal(third.actions.length, 1, 'and the now-approved job is acted on (dry run)');
});
