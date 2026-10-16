import fs from 'node:fs';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';

// Applications actually sent in the owner's name, read from the hunt store
// (the autopilot's record): application emails that were sent, and form
// applications that were submitted. Prepared or blocked ones are left out,
// like the Markdown ledger lists. Read-only; never creates the database.

const FORM_STATUS = { submitted: 'applied', unconfirmed: 'unconfirmed' };

export function listHuntApplications(vaultDir) {
  const file = huntDbPath(vaultDir);
  if (!fs.existsSync(file)) return [];
  let store;
  try { store = openStore(file); } catch { return []; }
  try {
    const records = new Map();
    const jobOf = (id) => store.getJob(id);
    for (const form of store.listApplications()) {
      const status = FORM_STATUS[form.status];
      const job = status ? jobOf(form.jobId) : null;
      if (!job) continue;
      const previous = records.get(form.jobId);
      if (previous && previous.updated_at >= form.updatedAt) continue;
      records.set(form.jobId, { job_id: form.jobId, company: job.company, title: job.role, status, url: form.url, applied_at: status === 'applied' ? form.updatedAt : null, updated_at: form.updatedAt });
    }
    for (const email of store.listEmails()) {
      if (email.kind !== 'application' || email.status !== 'sent' || records.has(email.jobId)) continue;
      const job = jobOf(email.jobId);
      if (!job) continue;
      records.set(email.jobId, {
        job_id: email.jobId, company: job.company, title: job.role, status: 'emailed', url: job.applicationUrls?.[0] ?? null,
        applied_at: email.updatedAt, updated_at: email.updatedAt, emailed_to: email.to, subject: email.subject, notes: email.body,
        attachments: email.attachments.map((item) => String(item).split('/').pop()),
      });
    }
    return [...records.values()];
  } finally { store.close(); }
}
