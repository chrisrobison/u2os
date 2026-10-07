import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { newId } from '../../db/ids.js';
import { getAgentAction } from '../../policy/policy-engine.js';
import { openStore, huntDbPath } from '../../../mcp/jobs/hunt/storage/store.js';
import { jobView, listJobViews } from '../../../mcp/jobs/hunt/view.js';
import { loadPreferences, loadResume } from '../../../mcp/jobs/hunt/candidate/profile.js';
import { proposeBulkDrafts } from '../../../mcp/jobs/hunt/applications/bulk.js';
import { SEND_TOOLS, proposeApplicationEmail, reconcileEmails, recordManualSend } from '../../../mcp/jobs/hunt/applications/send.js';

// Owner-only (router default). The Job hunt page and the owner's send
// button. Sending is an action on the owner's behalf, so it is proposed
// through the same gate as every other action (policy, approval, queue,
// audit); nothing here sends anything itself.

const JOB_ID = /^job_[0-9a-f]{16}$/;

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

export function registerJobHuntRoutes(router, { agent, toolRegistry }) {
  router.get('/api/job-hunt/jobs', async (req, res) => {
    reconcileOutcomes();
    const minScore = req.query?.min_score ? Number(req.query.min_score) : null;
    if (minScore !== null && !Number.isFinite(minScore)) return sendJson(res, 400, { error: 'min_score must be a number' });
    const prefs = preferences();
    const jobs = withStore((store) => listJobViews(store, { minScore, status: req.query?.status || null, limit: Number(req.query?.limit) || 100, minimumScore: prefs.minimum_score }));
    const counts = withStore((store) => store.counts());
    sendJson(res, 200, { minimumScore: prefs.minimum_score, counts, jobs, sendRoutes: availableRoutes(toolRegistry) });
  });

  router.get('/api/job-hunt/jobs/:id', async (req, res) => {
    if (!JOB_ID.test(req.params.id)) return sendJson(res, 400, { error: 'Invalid job id' });
    reconcileOutcomes();
    const view = withStore((store) => { const job = store.getJob(req.params.id); return job ? jobView(store, job, { minimumScore: preferences().minimum_score, detail: true }) : null; });
    if (!view) return sendJson(res, 404, { error: 'No such job' });
    sendJson(res, 200, view);
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
