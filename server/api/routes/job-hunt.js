import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { newId } from '../../db/ids.js';
import { getAgentAction } from '../../policy/policy-engine.js';
import { openStore, huntDbPath } from '../../../mcp/jobs/hunt/storage/store.js';
import { buildDashboard, moveJob, DEFAULT_WINDOW_DAYS } from '../../../mcp/jobs/hunt/dashboard.js';
import { addInterview, updateInterview, deleteInterview, addTask, completeTask, uncompleteTask, snoozeTask } from '../../../mcp/jobs/hunt/schedule.js';
import { addContact, updateContact, deleteContact, markContacted } from '../../../mcp/jobs/hunt/contacts.js';
import { jobView, listJobViews } from '../../../mcp/jobs/hunt/view.js';
import { addCustomAnswers } from '../../../mcp/jobs/hunt/candidate/answers.js';
import { ownerApproveAndSubmit, prefillApplicationForm, withLock } from '../../../mcp/jobs/hunt/act.js';
import { planJob } from '../../jobhunt/replan.js';
import { ensureMaterials } from '../../jobhunt/ensure-materials.js';
import { chooseApplyUrl } from '../../../mcp/jobs/hunt/applications/form/submit.js';
import { JOB_HUNT_DIR } from '../../../mcp/jobs/profile.js';
import { loadPreferences, loadResume } from '../../../mcp/jobs/hunt/candidate/profile.js';
import { setAutopilotSwitches } from '../../../mcp/jobs/hunt/autopilot/config.js';
import { proposeBulkDrafts } from '../../../mcp/jobs/hunt/applications/bulk.js';
import { SEND_TOOLS, proposeApplicationEmail, reconcileEmails, recordManualSend } from '../../../mcp/jobs/hunt/applications/send.js';

// Owner-only (router default). The Job hunt page and the owner's send
// button. Sending is an action on the owner's behalf, so it is proposed
// through the same gate as every other action (policy, approval, queue,
// audit); nothing here sends anything itself.

const JOB_ID = /^job_[0-9a-f]{16}$/;
const ROW_ID = /^[1-9][0-9]{0,9}$/;
const SCREENSHOT_FILE = /^[A-Za-z0-9_.-]{1,80}\.png$/;
const SCREENSHOT_DIR = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const screensDir = () => path.join(getVaultDir(), JOB_HUNT_DIR, 'state', 'screens');
const SCHEDULE_ERRORS = { BAD_INPUT: 400, UNKNOWN_JOB: 404, UNKNOWN_INTERVIEW: 404, UNKNOWN_TASK: 404, UNKNOWN_CONTACT: 404, CONFLICT: 409 };

function withStore(fn) {
  const store = openStore(huntDbPath(getVaultDir()));
  try { return fn(store); } finally { store.close(); }
}

function preferences() {
  try { return loadPreferences(getVaultDir()); } catch { return { minimum_score: 82 }; }
}

/** Marks jobs from the recorded outcome of their approved sends. Safe to call any time. */
export function reconcileOutcomes({ followUpDays = 5, now = new Date() } = {}) {
  return withStore((store) => reconcileEmails({ store, lookup: (id) => getAgentAction(id), followUpDays, now }));
}

export function registerJobHuntRoutes(router, { agent, toolRegistry, autopilot = null, jobLlm = null }) {
  if (autopilot) {
    router.get('/api/job-hunt/autopilot', async (req, res) => sendJson(res, 200, autopilot.status()));
    // Owner-only. Switching to live is the owner's decision, the same as editing autopilot.yaml.
    router.put('/api/job-hunt/autopilot', async (req, res) => {
      try { setAutopilotSwitches(getVaultDir(), { enabled: req.body?.enabled, mode: req.body?.mode }, { channel: 'api' }); } catch (error) { return sendJson(res, 400, { error: error.message }); }
      sendJson(res, 200, autopilot.status());
    });
    router.post('/api/job-hunt/autopilot/run', async (req, res) => {
      if (autopilot.running) return sendJson(res, 409, { error: 'A cycle is already running' });
      autopilot.runCycle().catch(() => {});
      sendJson(res, 202, { started: true });
    });
  }
  router.get('/api/job-hunt/jobs', async (req, res) => {
    reconcileOutcomes();
    const minScore = req.query?.min_score ? Number(req.query.min_score) : null;
    if (minScore !== null && !Number.isFinite(minScore)) return sendJson(res, 400, { error: 'min_score must be a number' });
    const prefs = preferences();
    const jobs = withStore((store) => listJobViews(store, { minScore, status: req.query?.status || null, limit: Number(req.query?.limit) || 100, minimumScore: prefs.minimum_score }));
    const counts = withStore((store) => store.counts());
    sendJson(res, 200, { minimumScore: prefs.minimum_score, counts, jobs, sendRoutes: availableRoutes(toolRegistry) });
  });

  // One call for the dashboard: pipeline stages with cards, analytics over a window, resume versions.
  router.get('/api/job-hunt/dashboard', async (req, res) => {
    reconcileOutcomes();
    const raw = req.query?.days;
    const days = raw == null || raw === '' ? DEFAULT_WINDOW_DAYS : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) return sendJson(res, 400, { error: 'days must be a whole number from 1 to 365' });
    sendJson(res, 200, withStore((store) => buildDashboard(store, { days })));
  });

  // The owner records the company's answer: screening, offer or rejected. Idempotent.
  router.post('/api/job-hunt/jobs/:id/status', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    try {
      sendJson(res, 200, withStore((store) => moveJob(store, req.params.id, req.body?.status)));
    } catch (error) {
      const status = { UNKNOWN_JOB: 404, BAD_TARGET: 400, BAD_TRANSITION: 409 }[error.code];
      if (!status) throw error;
      sendJson(res, status, { error: error.message });
    }
  });

  // Interviews and tasks tied to a job (owner only; validation lives in mcp/jobs/hunt/schedule.js).
  // Recording an interview moves the job to `interview` when its status allows it.
  const schedule = (idPattern, run) => async (req, res) => {
    const id = req.params.id;
    if (!idPattern.test(id)) return sendJson(res, 400, { error: 'Invalid id' });
    try {
      const { status = 200, body } = withStore((store) => run(store, idPattern === ROW_ID ? Number(id) : id, req.body ?? {}));
      sendJson(res, status, body);
    } catch (error) {
      const status = SCHEDULE_ERRORS[error.code];
      if (!status) throw error;
      sendJson(res, status, { error: error.message });
    }
  };
  router.post('/api/job-hunt/jobs/:id/interviews', schedule(JOB_ID, (store, id, body) => {
    const result = addInterview(store, id, body);
    return { status: result.created ? 201 : 200, body: result };
  }));
  router.patch('/api/job-hunt/interviews/:id', schedule(ROW_ID, (store, id, body) => ({ body: updateInterview(store, id, body) })));
  router.delete('/api/job-hunt/interviews/:id', schedule(ROW_ID, (store, id) => ({ body: deleteInterview(store, id) })));
  router.post('/api/job-hunt/jobs/:id/tasks', schedule(JOB_ID, (store, id, body) => ({ status: 201, body: addTask(store, id, body) })));
  router.post('/api/job-hunt/tasks/:id/complete', schedule(ROW_ID, (store, id) => ({ body: completeTask(store, id) })));
  router.post('/api/job-hunt/tasks/:id/uncomplete', schedule(ROW_ID, (store, id) => ({ body: uncompleteTask(store, id) })));
  router.post('/api/job-hunt/tasks/:id/snooze', schedule(ROW_ID, (store, id, body) => ({ body: snoozeTask(store, id, body) })));

  // Networking contacts per job (owner only; logic in mcp/jobs/hunt/contacts.js). The mail action in the UI is a
  // mailto: link: nothing here sends or drafts mail.
  router.post('/api/job-hunt/jobs/:id/contacts', schedule(JOB_ID, (store, id, body) => ({ status: 201, body: addContact(store, id, body) })));
  router.patch('/api/job-hunt/contacts/:id', schedule(ROW_ID, (store, id, body) => ({ body: updateContact(store, id, body) })));
  router.delete('/api/job-hunt/contacts/:id', schedule(ROW_ID, (store, id) => ({ body: deleteContact(store, id) })));
  router.post('/api/job-hunt/contacts/:id/contacted', schedule(ROW_ID, (store, id) => ({ body: markContacted(store, id) })));

  router.get('/api/job-hunt/jobs/:id', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    reconcileOutcomes();
    const view = withStore((store) => { const job = store.getJob(req.params.id); return job ? jobView(store, job, { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }) : null; });
    if (!view) return sendJson(res, 404, { error: 'No such job' });
    sendJson(res, 200, { ...view, sendRoutes: availableRoutes(toolRegistry) });
  });

  // The owner answers questions the planner could not. The questions come from the job's latest plan (a client cannot invent
  // one or change its label), the answers are saved under `custom:` in answers.yaml, and the form is planned again.
  router.post('/api/job-hunt/jobs/:id/answers', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const given = req.body?.answers;
    if (!Array.isArray(given) || !given.length || given.length > 50) return sendJson(res, 400, { error: 'answers must be a list of 1 to 50 { key, value }' });
    const vaultDir = getVaultDir();
    try {
      const body = await withLock(vaultDir, req.params.id, async () => {
        const store = openStore(huntDbPath(vaultDir));
        try {
          const job = store.getJob(req.params.id);
          if (!job) throw Object.assign(new Error('No such job'), { code: 'UNKNOWN_JOB' });
          const application = store.listApplications(job.id).at(-1);
          if (!application || !['needs_input', 'planned'].includes(application.status) || !application.plan?.unresolved?.length) throw Object.assign(new Error('This job has no unanswered questions'), { code: 'CONFLICT' });
          const entries = [];
          for (const item of given) {
            const question = application.plan.unresolved.find((entry) => entry.key === item?.key);
            if (!question) throw Object.assign(new Error('That question is not waiting for an answer'), { code: 'BAD_INPUT' });
            let value = typeof item.value === 'string' ? item.value.trim() : item.value;
            if (question.options?.length) {
              const option = question.options.find((entry) => entry.toLowerCase() === String(value).trim().toLowerCase());
              if (!option) throw Object.assign(new Error(`"${String(question.label).slice(0, 80)}" must be one of the form's choices`), { code: 'BAD_INPUT' });
              value = option;
            }
            entries.push({ label: question.label, value });
          }
          const { saved } = addCustomAnswers(vaultDir, entries, { channel: 'api' });
          let replanned = null; let replanError = null;
          try { replanned = await planJob({ vaultDir, store, job }); } catch (error) { replanError = String(error.message).slice(0, 300); }
          const fresh = store.getJob(job.id);
          return { saved, status: replanned?.status ?? application.status, unresolved: (replanned?.plan ?? application.plan).unresolved.length, ...(replanError ? { replanError } : {}), job: { ...jobView(store, fresh, { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }), sendRoutes: availableRoutes(toolRegistry) } };
        } finally { store.close(); }
      });
      sendJson(res, 200, body);
    } catch (error) {
      const status = { BAD_INPUT: 400, UNKNOWN_JOB: 404, CONFLICT: 409, IN_PROGRESS: 409 }[error.code];
      if (!status) return sendJson(res, 500, { error: String(error.message).slice(0, 300) });
      sendJson(res, status, { error: error.message });
    }
  });

  // The owner pressed "Prepare Email" (mode draft: a draft in Mail's Drafts, nothing sent) or "Apply via Email" (mode send).
  // Writes the job's materials first when they do not exist yet. Both go through the same gate as every other action: a
  // policy that wants approval shows up as `pending`. The score threshold is the owner's call here; duplicates still block.
  router.post('/api/job-hunt/jobs/:id/email', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const mode = req.body?.mode;
    if (!['draft', 'send'].includes(mode)) return sendJson(res, 400, { error: 'mode must be draft or send' });
    const routes = availableRoutes(toolRegistry);
    const via = mode === 'draft' ? 'apple_mail_draft' : (routes.apple_mail ? 'apple_mail' : 'gmail');
    const tool = SEND_TOOLS[via];
    if (!routes[via]) return sendJson(res, 409, { error: mode === 'draft' ? `${tool} is not available. Enable the Apple add-on on the Add-ons page (macOS only), then try again.` : 'No email route is available: enable the Apple add-on or connect Gmail.' });
    const vaultDir = getVaultDir();
    let resume;
    try { resume = loadResume(vaultDir); } catch (error) { return sendJson(res, 409, { error: error.message }); }
    try {
      const body = await withLock(vaultDir, req.params.id, async () => {
        const store = openStore(huntDbPath(vaultDir));
        try {
          const job = store.getJob(req.params.id);
          if (!job) throw Object.assign(new Error('No such job'), { code: 'UNKNOWN_JOB' });
          if (!job.contactEmails.length && !store.getArtifacts(job.id).email_json) throw Object.assign(new Error('This listing has no email address. Use Apply Online, or add a contact.'), { code: 'CONFLICT' });
          await ensureMaterials({ vaultDir, store, job, llm: jobLlm });
          const result = await proposeApplicationEmail({
            store, job: store.getJob(job.id), candidateEmail: resume.basics.email, minimumScore: preferences().minimum_score, tool, force: true,
            propose: (proposal) => agent.evaluateAndMaybeExecute({ tool: proposal.tool, arguments: proposal.arguments, requestedBy: 'owner', requestText: proposal.requestText, reasoningSummary: proposal.reasoning, correlationId: newId('corr'), actor: { type: 'user', id: 'user' } }),
          });
          const fresh = store.getJob(job.id);
          return { mode, via, status: result.outcome.status, actionId: result.outcome.id, reason: result.outcome.reason ?? null, email: { id: result.email.id, to: result.email.to, status: result.email.status }, job: { ...jobView(store, fresh, { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }), sendRoutes: routes } };
        } finally { store.close(); }
      });
      sendJson(res, 200, body);
    } catch (error) {
      const status = { BAD_INPUT: 400, UNKNOWN_JOB: 404, CONFLICT: 409, IN_PROGRESS: 409, NO_MODEL: 409, BLOCKED: 409 }[error.code];
      sendJson(res, status ?? 500, { error: String(error.message).slice(0, 400) });
    }
  });

  // "Apply Online": reads the job's application form and plans every answer. Submits nothing; the owner's two-step approval does that.
  router.post('/api/job-hunt/jobs/:id/plan', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const vaultDir = getVaultDir();
    try {
      const body = await withLock(vaultDir, req.params.id, async () => {
        const store = openStore(huntDbPath(vaultDir));
        try {
          const job = store.getJob(req.params.id);
          if (!job) throw Object.assign(new Error('No such job'), { code: 'UNKNOWN_JOB' });
          const url = chooseApplyUrl(job);
          if (!url) throw Object.assign(new Error('This listing has no application link. Use Apply via Email.'), { code: 'CONFLICT' });
          await ensureMaterials({ vaultDir, store, job, need: 'form', llm: jobLlm });
          const application = await planJob({ vaultDir, store, job: store.getJob(job.id), llm: jobLlm, url });
          return { status: application.status, ready: application.plan?.ready === true, unresolved: application.plan?.unresolved?.length ?? 0, job: { ...jobView(store, store.getJob(job.id), { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }), sendRoutes: availableRoutes(toolRegistry) } };
        } finally { store.close(); }
      });
      sendJson(res, 200, body);
    } catch (error) {
      const status = { UNKNOWN_JOB: 404, CONFLICT: 409, IN_PROGRESS: 409, NO_MODEL: 409 }[error.code];
      sendJson(res, status ?? 500, { error: String(error.message).slice(0, 400) });
    }
  });

  // "Open and pre-fill": plans the form if it is not already planned, then opens it in a visible browser window, fills the
  // planned answers and leaves the window open. Submits nothing; the owner reads it over and sends it themselves.
  router.post('/api/job-hunt/jobs/:id/prefill', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const vaultDir = getVaultDir();
    const view = (store) => ({ ...jobView(store, store.getJob(req.params.id), { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }), sendRoutes: availableRoutes(toolRegistry) });
    try {
      const planned = await withLock(vaultDir, req.params.id, async () => {
        const store = openStore(huntDbPath(vaultDir));
        try {
          const job = store.getJob(req.params.id);
          if (!job) throw Object.assign(new Error('No such job'), { code: 'UNKNOWN_JOB' });
          if (['applied', 'contacted', 'rejected', 'withdrawn', 'closed', 'skipped', 'interview', 'offer'].includes(job.status)) throw Object.assign(new Error(`This job is ${job.status.replace(/_/g, ' ')}.`), { code: 'CONFLICT' });
          const url = chooseApplyUrl(job);
          if (!url) throw Object.assign(new Error('This listing has no application link.'), { code: 'CONFLICT' });
          const latest = store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1);
          if (latest?.status === 'planned' && latest.plan?.ready === true && latest.url === url) return { ready: true };
          await ensureMaterials({ vaultDir, store, job, need: 'form', llm: jobLlm });
          const application = await planJob({ vaultDir, store, job: store.getJob(job.id), llm: jobLlm, url });
          return { ready: application.plan?.ready === true, status: application.status, unresolved: application.plan?.unresolved?.length ?? 0, job: view(store) };
        } finally { store.close(); }
      });
      if (!planned.ready) return sendJson(res, 200, { status: 'needs_input', unresolved: planned.unresolved, job: planned.job ?? withStore(view) });
      const outcome = await prefillApplicationForm({ vaultDir, jobId: req.params.id });
      sendJson(res, 200, { ...outcome, job: withStore(view) });
    } catch (error) {
      const status = { UNKNOWN_JOB: 404, CONFLICT: 409, IN_PROGRESS: 409, NO_MODEL: 409, NOT_READY: 409, BLOCKED: 409 }[error.code];
      sendJson(res, status ?? 500, { error: String(error.message).slice(0, 400) });
    }
  });

  // The owner looked at the planned application and sends it. `planHash` must be the plan they were shown, and `confirm`
  // must be literally true. Records the owner's approval and submits through the same guarded path as the autopilot, live.
  router.post('/api/job-hunt/jobs/:id/approve-and-submit', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    if (req.body?.confirm !== true) return sendJson(res, 400, { error: 'confirm must be true' });
    if (typeof req.body?.planHash !== 'string' || !req.body.planHash) return sendJson(res, 400, { error: 'planHash is required' });
    const vaultDir = getVaultDir();
    try {
      const outcome = await ownerApproveAndSubmit({ vaultDir, jobId: req.params.id, planHash: req.body.planHash });
      const job = withStore((store) => { const found = store.getJob(req.params.id); return found ? { ...jobView(store, found, { minimumScore: preferences().minimum_score, detail: true, screensDir: screensDir() }), sendRoutes: availableRoutes(toolRegistry) } : null; });
      sendJson(res, 200, { ...outcome, job });
    } catch (error) {
      const status = { UNKNOWN_JOB: 404, NOT_READY: 409, STALE_PLAN: 409, CHECKS_FAILED: 409, IN_PROGRESS: 409, NOT_APPROVED: 409, REFUSED: 409, BLOCKED: 409 }[error.code];
      if (!status) return sendJson(res, 500, { error: String(error.message).slice(0, 300) });
      sendJson(res, status, { error: error.message, code: error.code });
    }
  });

  // A screenshot of one of the job's application attempts: a PNG under
  // job-hunt/state/screens/<job id>/, a regular file, no links out. The path
  // is relative to that folder, as the job's `applications[].result.screenshots` lists it.
  router.get('/api/job-hunt/jobs/:id/screenshot', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const parts = String(req.query?.path || '').split('/');
    const name = parts.pop();
    if (parts.length > 3 || !SCREENSHOT_FILE.test(name ?? '') || parts.some((part) => !SCREENSHOT_DIR.test(part) || part === '.' || part === '..')) return sendJson(res, 400, { error: 'Not an application screenshot' });
    const root = path.join(screensDir(), req.params.id);
    const file = path.join(root, ...parts, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
      const realRoot = fs.realpathSync(root);
      const realDir = path.dirname(fs.realpathSync(file));
      if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES || (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep))) return sendJson(res, 404, { error: 'Not Found' });
    } catch { return sendJson(res, 404, { error: 'Not Found' }); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });

  router.post('/api/job-hunt/reconcile', async (req, res) => {
    sendJson(res, 200, { changes: reconcileOutcomes().map((change) => ({ to: change.email.to, status: change.to })) });
  });

  // The owner sent the email themselves (for example a draft sent by hand in Mail).
  router.post('/api/job-hunt/jobs/:id/mark-sent', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    let resume;
    try { resume = loadResume(getVaultDir()); } catch (error) { return sendJson(res, 409, { error: error.message }); }
    try {
      const email = withStore((store) => { const job = store.getJob(req.params.id); return job ? recordManualSend({ store, job, candidateEmail: resume.basics.email, to: typeof req.body?.to === 'string' ? req.body.to : undefined }) : null; });
      if (!email) return sendJson(res, 404, { error: 'No such job' });
      sendJson(res, 200, { email: { id: email.id, to: email.to, status: email.status } });
    } catch (error) { sendJson(res, 400, { error: error.message }); }
  });

  // Drafts in Mail for every ready job with an email route. Nothing is sent: each draft still passes the gate,
  // and the owner reviews and sends it from Mail.
  router.post('/api/job-hunt/drafts', async (req, res) => {
    const tool = SEND_TOOLS.apple_mail_draft;
    if (!hasTool(toolRegistry, tool)) return sendJson(res, 409, { error: `${tool} is not available. Enable the Apple add-on on the Add-ons page (macOS only), then try again.` });
    let resume;
    try { resume = loadResume(getVaultDir()); } catch (error) { return sendJson(res, 409, { error: error.message }); }
    const prefs = preferences();
    const minScore = Number.isFinite(Number(req.body?.min_score)) ? Number(req.body.min_score) : 70;
    const result = await withStoreAsync((store) => proposeBulkDrafts({
      store, candidateEmail: resume.basics.email, minimumScore: prefs.minimum_score, minScore,
      propose: (proposal) => agent.evaluateAndMaybeExecute({ tool: proposal.tool, arguments: proposal.arguments, requestedBy: 'owner', requestText: proposal.requestText, reasoningSummary: proposal.reasoning, correlationId: newId('corr'), actor: { type: 'user', id: 'user' } }),
    }));
    sendJson(res, 200, result);
  });

  router.post('/api/job-hunt/jobs/:id/send', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    const via = req.body?.via ?? 'gmail';
    if (!Object.hasOwn(SEND_TOOLS, via)) return sendJson(res, 400, { error: `via must be one of ${Object.keys(SEND_TOOLS).join(', ')}` });
    const tool = SEND_TOOLS[via];
    // No silent fallback: if the chosen route's tool is not available, say so.
    if (!hasTool(toolRegistry, tool)) {
      return sendJson(res, 409, { error: via === 'gmail' ? 'The email tool is unavailable.' : `${tool} is not available. Enable the Apple add-on on the Add-ons page (macOS only), then try again.` });
    }
    const vaultDir = getVaultDir();
    let resume;
    try { resume = loadResume(vaultDir); } catch (error) { return sendJson(res, 409, { error: error.message }); }
    const prefs = preferences();
    try {
      const result = await withStoreAsync((store) => {
        const job = store.getJob(req.params.id);
        if (!job) return null;
        return proposeApplicationEmail({
          store, job, candidateEmail: resume.basics.email, minimumScore: prefs.minimum_score, tool, force: req.body?.force === true,
          propose: (proposal) => agent.evaluateAndMaybeExecute({
            tool: proposal.tool, arguments: proposal.arguments, requestedBy: 'owner', requestText: proposal.requestText, reasoningSummary: proposal.reasoning,
            correlationId: newId('corr'), actor: { type: 'user', id: 'user' },
          }),
        });
      });
      if (!result) return sendJson(res, 404, { error: 'No such job' });
      sendJson(res, 200, { status: result.outcome.status, actionId: result.outcome.id, reason: result.outcome.reason ?? null, email: { id: result.email.id, to: result.email.to, status: result.email.status } });
    } catch (error) {
      sendJson(res, error.code === 'BLOCKED' ? 409 : 400, { error: error.message });
    }
  });
}

async function withStoreAsync(fn) {
  const store = openStore(huntDbPath(getVaultDir()));
  try { return await fn(store); } finally { store.close(); }
}

function hasTool(toolRegistry, name) {
  try { return Boolean(toolRegistry.get(name)) && !toolRegistry.isHidden?.(name); } catch { return false; }
}

function availableRoutes(toolRegistry) {
  return Object.fromEntries(Object.entries(SEND_TOOLS).map(([via, tool]) => [via, hasTool(toolRegistry, tool)]));
}
