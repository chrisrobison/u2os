import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../router.js';
import { getVaultDir } from '../../vault/vault-dir.js';
import { applicationsDir, listRecords, STATUSES } from '../../../mcp/jobs/ledger.js';

// Owner-only (router default). The job-hunt ledger is files in the owner's
// vault (docs/job-hunt.md), written by the job-hunt MCP server; these
// routes only read it for the Job applications view.

const SCREENSHOT = /^job-hunt\/applications\/[A-Za-z0-9_.-]{1,200}\.png$/;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export function registerJobApplicationRoutes(router) {
  router.get('/api/job-applications', async (req, res) => {
    const status = req.query?.status || null;
    if (status && !STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${STATUSES.join(', ')}` });
    const all = listRecords(getVaultDir()).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const counts = Object.fromEntries(STATUSES.map((name) => [name, all.filter((record) => record.status === name).length]));
    sendJson(res, 200, { counts, applications: all.filter((record) => !status || record.status === status).map(present) });
  });

  // Screenshots are served only from the ledger folder: vault-relative PNG
  // paths, regular files, no links out.
  router.get('/api/job-applications/screenshot', async (req, res) => {
    const relative = String(req.query?.path || '');
    if (!SCREENSHOT.test(relative) || relative.includes('..')) return sendJson(res, 400, { error: 'Not a ledger screenshot' });
    const vaultDir = getVaultDir();
    const file = path.join(vaultDir, ...relative.split('/'));
    let stat;
    try { stat = fs.lstatSync(file); } catch { return sendJson(res, 404, { error: 'Not Found' }); }
    const dir = applicationsDir(vaultDir);
    if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES || path.dirname(file) !== dir || path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

function present(record) {
  const url = typeof record.url === 'string' && /^https?:\/\//i.test(record.url) ? record.url : null;
  return {
    jobId: record.job_id,
    company: record.company ?? null,
    title: record.title ?? null,
    status: record.status ?? null,
    url,
    appliedAt: record.applied_at ?? null,
    updatedAt: record.updated_at ?? null,
    answered: record.answered && typeof record.answered === 'object' ? record.answered : {},
    openQuestions: Array.isArray(record.open_questions) ? record.open_questions : [],
    errors: Array.isArray(record.errors) ? record.errors : [],
    reason: record.reason ?? null,
    coverLetter: record.notes || null,
    screenshots: [record.screenshot, record.result_screenshot].filter((item) => typeof item === 'string' && SCREENSHOT.test(item)),
  };
}
