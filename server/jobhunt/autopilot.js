import fs from 'node:fs';
import path from 'node:path';
import { getVaultDir } from '../vault/vault-dir.js';
import { getAgentAction } from '../policy/policy-engine.js';
import { newId } from '../db/ids.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';
import { loadAutopilotConfig } from '../../mcp/jobs/hunt/autopilot/config.js';
import { loadCandidate } from '../../mcp/jobs/hunt/candidate/load.js';
import { discoverSources } from '../../mcp/jobs/hunt/discover-sources.js';
import { resolveBoards } from '../../mcp/jobs/hunt/sources/boards.js';
import { scoreJobs } from '../../mcp/jobs/hunt/score-run.js';
import { generateMaterials } from '../../mcp/jobs/hunt/applications/materials.js';
import { contactEmailsFor } from '../../mcp/jobs/hunt/applications/strategy.js';
import { chooseApplyUrl, planApplication, recoverInterrupted } from '../../mcp/jobs/hunt/applications/form/submit.js';
import { reviewJob } from '../../mcp/jobs/hunt/review/agent.js';
import { loadSubject, reviewPolicy } from '../../mcp/jobs/hunt/review/subject.js';
import { reconcileEmails } from '../../mcp/jobs/hunt/applications/send.js';
import { JOB_HUNT_DIR } from '../../mcp/jobs/profile.js';
import { stageAttachment, resolveAttachments } from '../tools/email-attachments.js';
import { createJobLlm } from './llm.js';

// The autonomous job hunter: a loop that finds, scores, prepares, reviews and
// (when live) acts on jobs, with no human in the middle.
//
//   discover -> score -> prepare materials + plan -> review agent -> act
//
// Autonomy lives in two places and both are the owner's: autopilot.yaml says
// whether the loop is enabled and whether it is `live` (default dry_run: it
// does everything except send/submit), and policies.yaml says whether the two
// narrow tools it calls (jobs.send_application, jobs.submit_application) need
// approval. Those tools only ever act on a job id with a current review
// approval, so nothing the loop (or a posting) says can send anything else.
//
// One cycle runs at a time, each step is isolated (a failing source or job
// never stops the others), and every step is bounded per cycle.

const MIN = 60_000;
const SOURCE_EVERY = { hn: 0, 'hn-jobs': 30 * MIN, remote: 30 * MIN };
const ACTIVE = new Set(['contacted', 'applied', 'interview', 'rejected', 'withdrawn', 'closed', 'skipped', 'uncertain', 'error']);

export const TOOLS = { email: 'jobs.send_application', form: 'jobs.submit_application' };

export class Autopilot {
  constructor({ agent, toolRegistry, vaultDir = null, deps = {}, clock = () => new Date(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, log = () => {} }) {
    this.agent = agent; this.toolRegistry = toolRegistry; this.fixedVault = vaultDir;
    this.deps = deps; this.clock = clock; this.setIntervalFn = setIntervalFn; this.clearIntervalFn = clearIntervalFn; this.log = log;
    this.running = false; this.timer = null; this.lastReport = null; this.lastFinished = 0;
  }

  get vaultDir() { return this.fixedVault ?? getVaultDir(); }
  statePath() { return path.join(this.vaultDir, JOB_HUNT_DIR, 'state', 'autopilot.json'); }
  loadState() { try { return JSON.parse(fs.readFileSync(this.statePath(), 'utf8')); } catch { return { lastRun: {}, lastReport: null }; } }
  saveState(state) { try { fs.mkdirSync(path.dirname(this.statePath()), { recursive: true }); fs.writeFileSync(this.statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch { /* best effort */ } }

  /** A one-minute tick; a cycle starts when the configured interval has passed. */
  start({ tickMs = MIN } = {}) {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      let config;
      try { config = loadAutopilotConfig(this.vaultDir); } catch { return; }
      if (!config.enabled || this.running) return;
      if (this.clock().getTime() - this.lastFinished < config.interval_seconds * 1000) return;
      this.runCycle().catch((error) => this.log(`autopilot cycle failed: ${error.message}`));
    }, tickMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) this.clearIntervalFn(this.timer); this.timer = null; }

  getAction(id) { return (this.deps.getAction ?? getAgentAction)(id); }

  hasTool(name) { try { return Boolean(this.toolRegistry.get(name)) && !this.toolRegistry.isHidden?.(name); } catch { return false; } }

  /** Whether the owner's policy lets each tool run without approval (so the owner can see what "live" means). */
  policyStatus() {
    const out = {};
    for (const [route, name] of Object.entries(TOOLS)) {
      let autonomous = null;
      try { autonomous = this.hasTool(name) ? !this.agent.actionEvaluator.evaluate({ tool: this.agent.actionEvaluator.resolve(name), arguments: { job_id: 'job_0000000000000000' } }).requiresApproval : null; } catch { autonomous = null; }
      out[route] = { tool: name, available: this.hasTool(name), autonomous };
    }
    return out;
  }

  status() {
    let config = null; let error = null;
    try { config = loadAutopilotConfig(this.vaultDir); } catch (e) { error = e.message; }
    return { config, error, running: this.running, lastReport: this.lastReport ?? this.loadState().lastReport, policy: this.policyStatus() };
  }

  async runCycle({ now = this.clock() } = {}) {
    if (this.running) return { skipped: 'a cycle is already running' };
    const config = loadAutopilotConfig(this.vaultDir);
    if (!config.enabled) return { skipped: 'disabled' };
    this.running = true;
    const report = { startedAt: now.toISOString(), mode: config.mode, steps: {}, actions: [], needsYou: [], errors: [] };
    const store = openStore(huntDbPath(this.vaultDir));
    const state = this.loadState();
    try {
      let candidate; let llm;
      try { candidate = loadCandidate(this.vaultDir); } catch (error) { report.errors.push(`candidate: ${error.message}`); return report; }
      try { llm = (this.deps.createLlm ?? createJobLlm)(); } catch { llm = null; }
      const ctx = { store, config, candidate, llm, now, report, state };
      for (const [name, step] of [['housekeeping', this.housekeeping], ['discover', this.discover], ['score', this.score], ['prepare', this.prepare], ['review', this.review], ['act', this.act]]) {
        try { report.steps[name] = await step.call(this, ctx); } catch (error) { report.errors.push(`${name}: ${String(error.message).slice(0, 200)}`); report.steps[name] = { error: true }; }
      }
    } finally {
      report.finishedAt = new Date().toISOString();
      state.lastReport = report;
      this.saveState(state);
      this.lastReport = report;
      this.lastFinished = this.clock().getTime();
      store.close();
      this.running = false;
    }
    return report;
  }

  // ---- steps -----------------------------------------------------------------

  async housekeeping({ store, now }) {
    const recovered = recoverInterrupted({ store, now });
    const changes = reconcileEmails({ store, lookup: (id) => this.getAction(id), now });
    return { recovered: recovered.length, reconciled: changes.length };
  }

  async discover({ store, config, candidate, state, now }) {
    const due = (name, everyMs) => !state.lastRun[name] || now.getTime() - Date.parse(state.lastRun[name]) >= everyMs;
    const result = {};
    const sources = config.sources.filter((name) => (name === 'boards' ? due('boards', config.boards_every_minutes * MIN) : due(name, SOURCE_EVERY[name] ?? 0)));
    for (const source of sources) {
      const boards = source === 'boards' ? resolveBoards({ vaultDir: this.vaultDir, store }) : [];
      const summaries = await (this.deps.discoverSources ?? discoverSources)({ store, source, preferences: candidate.preferences, boards, now });
      state.lastRun[source] = now.toISOString();
      result[source] = summaries.map((summary) => ({ source: summary.source, created: summary.created ?? 0, errors: (summary.errors ?? []).length }));
    }
    return result;
  }

  async score({ store, config, candidate, llm, now }) {
    if (!llm?.available || !config.per_cycle.score) return { skipped: 'no model or no budget' };
    const summary = await (this.deps.scoreJobs ?? scoreJobs)({ store, resume: candidate.resume, preferences: candidate.preferences, repos: candidate.repos, llm, limit: config.per_cycle.score, now });
    return { scored: summary.scored, screened: summary.screened, errors: summary.errors.length };
  }

  /** Jobs worth preparing: model-scored at or above the threshold, not acted on, nothing prepared yet. */
  candidatesToPrepare({ store, candidate, config, limit }) {
    const minimum = candidate.preferences.minimum_score ?? 82;
    return store.listScored({ minScore: minimum, limit: 500 })
      // A form-only job cannot be worked while the forms route is off, and must not use up the cycle's preparation budget.
      .filter(({ job, score }) => !score.degraded && !ACTIVE.has(job.status) && job.status !== 'needs_input' && !store.getArtifacts(job.id).resume_pdf && (config.routes.form || contactEmailsFor(job).length > 0))
      .slice(0, limit).map(({ job }) => job);
  }

  async prepare({ store, config, candidate, llm, now, report }) {
    if (!llm?.available) return { skipped: 'no model' };
    const prepared = [];
    for (const job of this.candidatesToPrepare({ store, candidate, config, limit: config.per_cycle.prepare })) {
      const emailRoute = contactEmailsFor(job).length > 0;
      const formUrl = chooseApplyUrl(job);
      if (!emailRoute && !formUrl) continue;
      if (!emailRoute && !config.routes.form) {
        // The form route is switched off: no materials, no plan, no review, no act. Parked for the owner.
        report.needsYou.push({ job: `${job.company} - ${job.role ?? ''}`, jobId: job.id, why: 'form-only job; the forms route is off in autopilot.yaml (routes.form)' });
        continue;
      }
      try {
        await (this.deps.generateMaterials ?? generateMaterials)({ store, vaultDir: this.vaultDir, job, candidate, llm, minimumScore: candidate.preferences.minimum_score, stage: stageAttachment, now });
        if (!emailRoute && formUrl) {
          let application = await (this.deps.planApplication ?? planApplication)({ store, job, candidate, llm, url: formUrl, now });
          if (application.plan.needs?.includes('cover_letter_required')) {
            await (this.deps.generateMaterials ?? generateMaterials)({ store, vaultDir: this.vaultDir, job, candidate, llm, minimumScore: candidate.preferences.minimum_score, stage: stageAttachment, force: true, coverLetter: true, now });
            application = await (this.deps.planApplication ?? planApplication)({ store, job, candidate, llm, url: formUrl, now });
          }
          if (application.status !== 'planned') report.needsYou.push({ job: `${job.company} - ${job.role ?? ''}`, jobId: job.id, why: application.plan.blockers?.length ? `blocked: ${application.plan.blockers.join(', ')}` : `needs: ${(application.plan.needs ?? []).join(', ') || 'input'}` });
        } else {
          const artifacts = store.getArtifacts(job.id);
          let needs = [];
          try { needs = JSON.parse(fs.readFileSync(artifacts.email_json.path, 'utf8')).needsInput ?? []; } catch { /* none */ }
          if (needs.length) report.needsYou.push({ job: `${job.company} - ${job.role ?? ''}`, jobId: job.id, why: `the listing asks for: ${needs.join('; ')}` });
        }
        prepared.push(job.id);
      } catch (error) {
        report.errors.push(`prepare ${job.company}: ${String(error.message).slice(0, 160)}`);
        store.recordEvent(job.id, 'autopilot_error', { detail: { step: 'prepare', error: String(error.message).slice(0, 300) } }, now);
        // Do not retry forever: park it for the owner.
        try { if (store.getJob(job.id).status === 'scored') store.transition(job.id, 'error', { step: 'prepare' }, now); } catch { /* ignore */ }
      }
    }
    const formOnly = config.routes.form ? 0 : store.listScored({ minScore: candidate.preferences.minimum_score ?? 82, limit: 500 }).filter(({ job, score }) => !score.degraded && !ACTIVE.has(job.status) && !contactEmailsFor(job).length && chooseApplyUrl(job) && !store.getArtifacts(job.id).resume_pdf).length;
    return { prepared: prepared.length, ...(formOnly ? { formOnlyWaiting: formOnly } : {}) };
  }

  /** The route a prepared job would use, with its current content hash. */
  routeFor(store, job, config) {
    const artifacts = store.getArtifacts(job.id);
    if (!artifacts.resume_pdf) return null;
    const email = artifacts.email_json ? (() => { try { return JSON.parse(fs.readFileSync(artifacts.email_json.path, 'utf8')); } catch { return null; } })() : null;
    if (email && !email.needsInput?.length && contactEmailsFor(job).length) return 'email';
    const application = store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1);
    if (config.routes.form && application && application.status === 'planned') return 'form';
    return null;
  }

  async review({ store, config, candidate, llm, now, report }) {
    if (!llm?.available) return { skipped: 'no model' };
    let reviewed = 0;
    for (const job of store.listJobs({ limit: 5000 })) {
      if (reviewed >= config.per_cycle.prepare) break;
      if (ACTIVE.has(job.status) || job.status === 'needs_input') continue;
      const kind = this.routeFor(store, job, config);
      if (!kind) continue;
      const subject = loadSubject({ store, job, kind, policy: reviewPolicy({ preferences: candidate.preferences, config }) });
      const latest = store.latestReview(job.id, kind);
      // Never review the same content twice: an unchanged rejection stays a rejection until something changes.
      if (latest && latest.contentHash === subject.contentHash) continue;
      const result = await (this.deps.reviewJob ?? reviewJob)({ store, job, kind, candidate, preferences: candidate.preferences, config, llm, now, verifyAttachments: (refs) => resolveAttachments(this.vaultDir, refs) });
      reviewed += 1;
      if (result.decision === 'reject') report.needsYou.push({ job: `${job.company} - ${job.role ?? ''}`, jobId: job.id, why: `review rejected (${kind}): ${result.notes}`.slice(0, 220) });
    }
    return { reviewed };
  }

  async act({ store, config, candidate, now, report }) {
    const done = [];
    for (const job of store.listJobs({ limit: 5000 })) {
      if (done.length >= config.per_cycle.act) break;
      if (ACTIVE.has(job.status) || job.status === 'needs_input') continue;
      const kind = this.routeFor(store, job, config);
      if (!kind) continue;
      const subject = loadSubject({ store, job, kind, policy: reviewPolicy({ preferences: candidate.preferences, config }) });
      const approval = store.validApproval(job.id, kind, subject.contentHash);
      if (!approval) continue;
      const tool = TOOLS[kind];
      const label = `${job.company} - ${job.role ?? ''}`;
      // Already handled for this exact approval?
      const prior = store.listEvents(job.id).filter((event) => event.type === 'autopilot_proposed' && event.detail.reviewId === approval.id).at(-1);
      if (config.mode !== 'live') {
        if (!store.listEvents(job.id).some((event) => event.type === 'autopilot_would_act' && event.detail.reviewId === approval.id)) {
          store.recordEvent(job.id, 'autopilot_would_act', { detail: { kind, tool, reviewId: approval.id } }, now);
          report.actions.push({ job: label, jobId: job.id, kind, result: 'dry_run: would act', to: kind === 'email' ? subject.email.to : subject.application.url });
          done.push(job.id);
        }
        continue;
      }
      if (prior) { const action = this.getAction(prior.detail.actionId); if (action && ['pending', 'executed', 'approved', 'queued'].includes(action.status)) continue; }
      if (!this.hasTool(tool)) { report.needsYou.push({ job: label, jobId: job.id, why: `${tool} is not available: enable the jobs tool server in mcp.yaml` }); continue; }
      const outcome = await (this.deps.propose ?? ((proposal) => this.agent.evaluateAndMaybeExecute(proposal)))({
        tool, arguments: { job_id: job.id }, requestedBy: 'job-autopilot', requestText: `Autopilot: ${kind === 'email' ? 'email' : 'apply to'} ${label}`,
        reasoningSummary: `Review approved (#${approval.id}): ${approval.notes}`.slice(0, 300), correlationId: newId('corr'), actor: { type: 'user', id: 'user' },
      });
      store.recordEvent(job.id, 'autopilot_proposed', { detail: { kind, tool, reviewId: approval.id, actionId: outcome.id, gate: outcome.status } }, now);
      if (outcome.result?.status === 'refused') report.needsYou.push({ job: label, jobId: job.id, why: `refused at act time: ${String(outcome.result.message).slice(0, 180)}` });
      report.actions.push({ job: label, jobId: job.id, kind, result: outcome.status === 'executed' ? `done: ${JSON.stringify(outcome.result ?? {}).slice(0, 160)}` : outcome.status === 'pending' ? 'waiting for your approval (policy requires it)' : outcome.status, to: kind === 'email' ? subject.email.to : subject.application.url });
      done.push(job.id);
    }
    return { acted: done.length };
  }
}
