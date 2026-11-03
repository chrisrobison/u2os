import { seedHuntStore } from './job-hunt-dashboard-seed.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';

// The real-server data for the Job Hunt polish and cross-view specs (#653): the dashboard seed (every board stage), plus
//   - a job that needs the owner (an unanswered required question), with a long company and role,
//   - a job with a planned, ready application (the "Ready to submit" box),
//   - a job that was sent and then withdrawn, and one sent and then closed (the Overview's Submitted card counts them
//     because they WERE sent; the Opportunities table lists by current status, so it cannot),
//   - `filler` scored jobs so the table pages and a long list is exercised.
// Times are relative to now.

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);
const SCORE = { confidence: 0.9, label: 'strong', dimensions: {}, reasons: ['Direct platform experience'], concerns: [], recommendedNarrative: 'developer-platform', projects: [], flags: [], degraded: false, model: 'm' };

export const LONG_COMPANY = 'Northern Lights Distributed Systems and Infrastructure Incorporated';
export const LONG_ROLE = 'Senior Staff Platform Engineer, Distributed Systems and Developer Productivity (Remote, US)';

export function seedPolishStore(vaultDir, { filler = 60 } = {}) {
  const ids = seedHuntStore(vaultDir);
  const store = openStore(huntDbPath(vaultDir));
  try {
    const add = (key, company, role, fit, walk = []) => {
      const { job } = store.upsertSighting({
        source: 'hackernews', sourceKey: `hackernews:${key}#0`, company, role, rawText: `${company} is hiring a ${role}.`,
        applicationUrls: [`https://jobs.example.com/${key}`], contactEmails: [], locations: ['Oakland, CA'], remote: true, salary: { raw: '$180K - $220K' }, technologies: [],
      }, ago(40));
      if (fit != null) store.saveScore(job.id, { ...SCORE, score: fit }, ago(40));
      for (const [status, days] of walk) store.transition(job.id, status, {}, ago(days));
      ids[key] = job.id;
      return job;
    };
    const needs = add('needs-1', LONG_COMPANY, LONG_ROLE, 91, [['qualified', 6], ['needs_input', 1]]);
    store.addApplication(needs.id, {
      kind: 'form', url: 'https://jobs.example.com/needs-1', status: 'needs_input', idempotencyKey: `${needs.id}-needs`,
      plan: { planHash: 'h-needs', ready: false, needs: [], blockers: [], unresolved: [{ key: 'custom:why', label: 'Why are you interested in this role?', reason: 'unknown_required_field', required: true }], fields: [] },
    });
    const ready = add('ready-1', 'Hooli Labs', 'Staff Software Engineer', 88, [['qualified', 4], ['materials_generated', 1]]);
    store.addApplication(ready.id, {
      kind: 'form', url: 'https://jobs.example.com/ready-1', status: 'planned', idempotencyKey: `${ready.id}-ready`,
      plan: { planHash: 'h-ready', ready: true, needs: [], blockers: [], unresolved: [], fields: [{ label: 'Email', required: true, origin: 'profile', value: 'pat@example.com' }, { label: 'Resume', required: true, origin: 'material', file: 'resume.pdf' }] },
    });
    add('withdrawn-1', 'Wayne Enterprises', 'Platform Engineer', 77, [['applied', 14], ['withdrawn', 3]]);
    add('closed-1', 'Stark Industries', 'Staff Engineer', 83, [['applied', 20], ['closed', 5]]);
    for (let i = 1; i <= filler; i += 1) add(`filler-${i}`, `Filler Company ${i}`, `Software Engineer ${i}`, 50 + (i % 45), [['qualified', 2 + (i % 20)]]);
  } finally { store.close(); }
  return ids;
}
