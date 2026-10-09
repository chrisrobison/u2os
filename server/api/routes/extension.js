import fs from 'node:fs';
import crypto from 'node:crypto';
import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { isLoopbackRequest } from '../../security/loopback.js';
import { PairingError } from '../../extension/pairings.js';
import { huntDbPath, openStore } from '../../../mcp/jobs/hunt/storage/store.js';
import { prepare, Refused, withLock } from '../../../mcp/jobs/hunt/act.js';
import { planHash } from '../../../mcp/jobs/hunt/applications/form/plan.js';

// The browser extension channel (docs/job-hunt.md "Browser extension channel").
//
// Owner routes (/api/extension/pairing-codes, /pairings) are ordinary
// cookie + CSRF routes. Everything under /api/extension/v1/ is `extension:`
// marked, so the Router runs the loopback + Host + bearer-token gate first
// (server/extension/channel.js) and never looks at the cookie session.
//
// Plans and files are served only through act.js prepare(): the same
// hash-bound review approval and just-now checks the autopilot needs. The
// extension is told what to fill; it is never handed anything unreviewed.

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_KINDS = { resume: 'resume_pdf', cover_letter: 'cover_letter_pdf', resume_with_letter: 'combined_pdf' };
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// "filled" is recorded as the result of a still-planned application: act.js prepare() (the plan_ready check) only accepts a planned one.
const OPEN = new Set(['planned']);
const FINISHED_JOB = ['applied', 'contacted', 'rejected', 'withdrawn', 'closed', 'skipped', 'interview'];
const REFUSAL_STATUS = { UNKNOWN_JOB: 404, NOT_APPROVED: 403, CHECKS_FAILED: 409, IN_PROGRESS: 409 };

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export function registerExtensionRoutes(router, { channel, vaultDir = getVaultDir, now = () => new Date() }) {
  const { pairings } = channel;

  // --- owner routes (web session, cookie + CSRF) -------------------------
  router.post('/api/extension/pairing-codes', async (req, res) => {
    if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'Pairing is only available on localhost' });
    sendJson(res, 201, pairings.createCode(), { 'Cache-Control': 'no-store' });
  });
  router.get('/api/extension/pairings', async (req, res) => sendJson(res, 200, { pairings: pairings.list() }));
  router.delete('/api/extension/pairings/:id', async (req, res) => {
    if (!pairings.revoke(req.params.id)) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, { revoked: true });
  });

  // --- extension routes (bearer token, loopback only) --------------------
  router.post('/api/extension/v1/pair', async (req, res) => {
    try {
      const { token, id, label } = pairings.exchange({ code: req.body?.code, origin: req.extensionAuth.origin, label: req.body?.label });
      sendJson(res, 201, { token, id, label });
    } catch (error) {
      if (error instanceof PairingError) return sendJson(res, error.status, { error: error.message });
      throw error;
    }
  }, { extension: 'pair' });

  router.get('/api/extension/v1/applications', async (req, res) => {
    const dir = vaultDir();
    if (!fs.existsSync(huntDbPath(dir))) return sendJson(res, 200, { applications: [] });
    const store = openStore(huntDbPath(dir));
    try {
      const applications = store.listApplications().filter((entry) => entry.kind === 'form' && OPEN.has(entry.status) && entry.plan?.ready)
        .map((entry) => { const job = store.getJob(entry.jobId); return job ? { jobId: entry.jobId, company: job.company, role: job.role ?? null, url: entry.url, status: entry.status } : null; })
        .filter(Boolean);
      sendJson(res, 200, { applications });
    } finally { store.close(); }
  }, { extension: 'token' });

  router.get('/api/extension/v1/jobs/:jobId/plan', async (req, res) => {
    const { store, job, application, config } = open(req);
    try {
      const plan = application.plan;
      const files = Object.entries(plan.files ?? {}).map(([kind, entry]) => {
        const field = plan.fields.find((candidate) => candidate.file === kind);
        return { kind, fileName: field?.fileName ?? null, sha256: entry.sha256, path: `/api/extension/v1/jobs/${job.id}/files/${kind}` };
      });
      // Remember that this exact plan was served under a valid approval: results are only accepted for it.
      store.updateApplication(application.id, { result: { servedPlanHash: application.planHash, servedAt: now().toISOString() } }, now());
      sendJson(res, 200, {
        jobId: job.id, company: job.company, role: job.role ?? null, url: application.url, status: application.status,
        planHash: application.planHash, schemaHash: plan.schemaHash, submitLabel: plan.submitLabel ?? null,
        fields: plan.fields.map(({ key, label, type, required, value, file, fileName, options }) => ({ key, label, type, required, ...(file ? { file, fileName } : { value }), ...(options ? { options } : {}) })),
        files, autoSubmit: config.mode === 'live',
      }, { 'Cache-Control': 'no-store' });
    } finally { store.close(); }
  }, { extension: 'token' });

  router.get('/api/extension/v1/jobs/:jobId/files/:kind', async (req, res) => {
    const kind = req.params.kind;
    if (!Object.hasOwn(FILE_KINDS, kind)) return sendJson(res, 404, { error: 'Not Found' });
    const { store, job, application } = open(req);
    try {
      const expected = application.plan.files?.[kind]?.sha256;
      const artifact = store.getArtifacts(job.id)[FILE_KINDS[kind]];
      if (!expected || !artifact) return sendJson(res, 404, { error: 'Not Found' });
      let bytes;
      try {
        const stat = fs.lstatSync(artifact.path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return sendJson(res, 404, { error: 'Not Found' });
        bytes = fs.readFileSync(artifact.path);
      } catch { return sendJson(res, 404, { error: 'Not Found' }); }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      // The bytes sent are the bytes that were reviewed, or nothing is sent.
      if (sha256 !== expected) return sendJson(res, 409, { error: 'The file changed since the plan was reviewed', code: 'FILES_CHANGED' });
      const fileName = String(application.plan.fields.find((field) => field.file === kind)?.fileName ?? `${kind}.pdf`).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'X-Content-SHA256': sha256, 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
    } finally { store.close(); }
  }, { extension: 'token' });

  // Intent, recorded before the extension clicks submit: from here a crash or a lost report is "uncertain", never "try again".
  router.post('/api/extension/v1/jobs/:jobId/submitting', async (req, res) => {
    await withLock(vaultDir(), jobId(req), async () => {
      const { store, job, application, config } = open(req);
      try {
        if (config.mode !== 'live') throw httpError(409, 'Dry run: the autopilot is not set to submit', 'DRY_RUN');
        if (req.body?.planHash !== application.planHash) throw httpError(409, 'The plan changed; fetch it again', 'STALE_PLAN');
        const at = now();
        store.updateApplication(application.id, { status: 'submitting' }, at);
        store.recordEvent(job.id, 'application_submitting', { detail: { applicationId: application.id, url: application.url, by: 'extension', pairingId: req.extensionAuth.pairing.id } }, at);
        sendJson(res, 200, { status: 'submitting' });
      } finally { store.close(); }
    }).catch((error) => handleError(res, error));
  }, { extension: 'token' });

  router.post('/api/extension/v1/jobs/:jobId/result', async (req, res) => {
    const outcome = req.body?.status;
    if (!['filled', 'submitted', 'failed'].includes(outcome)) return sendJson(res, 400, { error: 'status must be filled, submitted or failed' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : null;
    await withLock(vaultDir(), jobId(req), async () => {
      const dir = vaultDir();
      if (!fs.existsSync(huntDbPath(dir))) throw httpError(404, 'Not Found');
      const store = openStore(huntDbPath(dir));
      try {
        const job = store.getJob(jobId(req));
        const application = job ? store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1) : null;
        if (!application) throw httpError(404, 'Not Found');
        // Only a plan that was served under a valid approval can have a result, and only that exact plan.
        if (req.body?.planHash !== application.planHash || application.result?.servedPlanHash !== application.planHash) throw httpError(409, 'No served plan matches this result', 'STALE_PLAN');
        const at = now();
        const recorded = { outcome, via: 'extension', pairingId: req.extensionAuth.pairing.id, ...(reason ? { reason } : {}), at: at.toISOString() };
        const event = () => store.recordEvent(job.id, 'application_result', { detail: { applicationId: application.id, outcome, by: 'extension' } }, at);
        const applied = () => { if (!FINISHED_JOB.includes(job.status)) store.transition(job.id, 'applied', { applicationId: application.id, url: application.url }, at); };
        if (application.status === 'submitting') {
          if (outcome === 'filled') throw httpError(409, 'A submit is in progress; report submitted or failed', 'IN_PROGRESS');
          if (outcome === 'submitted') {
            store.updateApplication(application.id, { status: 'submitted', result: recorded }, at);
            event(); applied();
          } else {
            // A failure after the click cannot be proven harmless: uncertain, and never retried.
            store.updateApplication(application.id, { status: 'uncertain', result: { ...recorded, reason: reason ?? 'the extension reported a failure after submitting began; outcome unknown' } }, at);
            event();
            if (!['applied', 'contacted'].includes(job.status)) store.transition(job.id, 'uncertain', { applicationId: application.id }, at);
          }
        } else if (OPEN.has(application.status)) {
          if (outcome === 'filled') store.updateApplication(application.id, { result: recorded }, at);
          else if (outcome === 'failed') store.updateApplication(application.id, { status: 'planned', result: recorded }, at); // nothing was submitted: safe to retry
          else { store.updateApplication(application.id, { status: 'submitted', result: { ...recorded, manual: true } }, at); applied(); } // the owner pressed submit in their own browser
          event();
        } else throw httpError(409, `The application is already ${application.status}`, 'BLOCKED');
        sendJson(res, 200, { status: store.listApplications(job.id).find((entry) => entry.id === application.id).status });
      } finally { store.close(); }
    }).catch((error) => handleError(res, error));
  }, { extension: 'token' });

  function jobId(req) {
    if (!JOB_ID.test(req.params.jobId)) throw httpError(400, 'Bad job id');
    return req.params.jobId;
  }

  /** prepare() (approval bound to the content hash + checks run now) and the latest open form application; throws an HTTP error otherwise. */
  function open(req) {
    const dir = vaultDir();
    if (!fs.existsSync(huntDbPath(dir))) throw httpError(404, 'Not Found');
    let ready;
    try { ready = prepare({ vaultDir: dir, jobId: jobId(req), kind: 'form', now: now() }); } catch (error) {
      if (error instanceof Refused) throw httpError(REFUSAL_STATUS[error.code] ?? 403, error.message, error.code);
      throw error;
    }
    const { store, job, config } = ready;
    const application = store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1);
    const fail = (status, message, code) => { store.close(); throw httpError(status, message, code); };
    if (!application) fail(404, 'No application plan for this job');
    if (!OPEN.has(application.status)) fail(409, `The application is ${application.status}`, 'BLOCKED');
    if (!application.plan?.ready) fail(409, 'The plan is not ready', 'NOT_READY');
    // The approval covers application.planHash; refuse a stored plan that no longer hashes to it.
    if (planHash(application.plan) !== application.planHash) fail(409, 'The stored plan does not match its hash', 'PLAN_TAMPERED');
    return { store, job, application, config };
  }

  function handleError(res, error) {
    if (error instanceof Refused) return sendJson(res, REFUSAL_STATUS[error.code] ?? 403, { error: error.message, code: error.code });
    if (error?.status) return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    throw error;
  }
}
