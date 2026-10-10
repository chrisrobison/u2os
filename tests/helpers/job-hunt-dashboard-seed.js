import fs from 'node:fs';
import path from 'node:path';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';

// Seeds a hunt store with one or two jobs in every dashboard stage, scores,
// status history and resume artifacts, with times relative to now so the
// analytics windows are stable. Expected analytics over the default 30 days:
// 6 sent, response rate 4/6, interview rate 3/6, 1 offer.

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY);

const DIMENSIONS = {
  experience: { points: 22, max: 25, reason: 'Led comparable platform teams' },
  seniority: { points: 18, max: 20, reason: 'Staff level matches' },
  technical: { points: 11, max: 15, reason: 'Overlap on Node and SQLite' },
};

function score(value, label, extra = {}) {
  return { score: value, confidence: 0.9, label, dimensions: DIMENSIONS, reasons: ['Direct platform experience'], concerns: ['Salary not stated'], recommendedNarrative: 'developer-platform', projects: [{ name: 'u2os', url: 'https://example.com/u2os', why: 'Local-first agent' }], flags: [], degraded: false, model: 'm', ...extra };
}

export const JOBS = [
  { key: 'saved-1', company: 'Acme Robotics', role: 'Staff Engineer', fit: 92, label: 'exceptional', walk: [['qualified', 3]] },
  { key: 'saved-2', company: 'Northwind', role: 'Platform Engineer', fit: 64, label: 'weak', walk: [['qualified', 5]] },
  { key: 'applied-1', company: 'Globex', role: 'Engineering Manager', fit: 85, label: 'strong', walk: [['applied', 2]] },
  { key: 'applied-2', company: 'Initech', role: 'Senior Engineer', fit: 78, label: 'plausible', walk: [['applied', 6], ['followup_due', 1]] },
  { key: 'screening-1', company: 'Hooli', role: 'Principal Engineer', fit: 90, label: 'exceptional', walk: [['applied', 8], ['screening', 3]] },
  { key: 'interview-1', company: 'Delta Systems', role: 'Director of Engineering', fit: 88, label: 'strong', walk: [['applied', 9], ['screening', 6], ['interview', 2]], technologies: ['Node.js', 'SQLite', 'TypeScript', 'Postgres', 'Kubernetes', 'Go', 'Rust', 'Python', 'Redis', 'Kafka'], companyUrl: 'https://delta.example.com' },
  { key: 'offer-1', company: 'Vandelay', role: 'Staff Platform Engineer', fit: 91, label: 'exceptional', walk: [['applied', 12], ['interview', 8], ['offer', 1]] },
  { key: 'rejected-1', company: 'Umbrella', role: 'Engineering Lead', fit: 70, label: 'plausible', walk: [['applied', 10], ['rejected', 4]] },
];

export function seedHuntStore(vaultDir, jobs = JOBS) {
  const store = openStore(huntDbPath(vaultDir));
  const ids = {};
  try {
    fs.mkdirSync(path.join(vaultDir, 'job-hunt', 'materials'), { recursive: true });
    const resume = path.join(vaultDir, 'job-hunt', 'materials', 'resume-platform.pdf');
    const letter = path.join(vaultDir, 'job-hunt', 'materials', 'cover-delta.pdf');
    fs.writeFileSync(resume, 'resume');
    fs.writeFileSync(letter, 'letter');
    for (const spec of jobs) {
      const { job } = store.upsertSighting({
        source: 'hackernews', sourceKey: `hackernews:${spec.key}#0`, company: spec.company, role: spec.role,
        rawText: `${spec.company} is hiring a ${spec.role}. We build reliable infrastructure for fleets of devices.`,
        applicationUrls: [`https://jobs.example.com/${spec.key}`], contactEmails: [], locations: ['Oakland, CA'], remote: true,
        salary: { raw: '$180K - $220K' }, technologies: spec.technologies ?? [], companyUrl: spec.companyUrl ?? null,
      }, ago(60));
      ids[spec.key] = job.id;
      if (spec.fit != null) store.saveScore(job.id, score(spec.fit, spec.label), ago(60));
      for (const [status, days] of spec.walk) store.transition(job.id, status, {}, ago(days));
    }
    if (ids['interview-1']) {
      store.addArtifact(ids['interview-1'], 'resume_pdf', resume, {}, ago(2));
      store.addArtifact(ids['interview-1'], 'cover_letter_pdf', letter, {}, ago(2));
    }
    // Interviews and tasks (#536), relative to now: two upcoming interviews, one overdue and one future task.
    // Initech is followup_due, so the dashboard generates its follow-up task itself.
    const inDays = (days, hour) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hour, 0, 0, 0); return d; };
    if (ids['interview-1']) {
      store.addInterview(ids['interview-1'], { at: inDays(2, 17).toISOString(), endsAt: inDays(2, 18).toISOString(), kind: 'video', round: 'Round 2', locationOrLink: 'https://meet.example.com/delta' });
      store.addTask(ids['interview-1'], { title: 'Send thank-you note', dueAt: ago(1).toISOString() });
    }
    if (ids['screening-1']) {
      store.addInterview(ids['screening-1'], { at: inDays(5, 16).toISOString(), endsAt: inDays(5, 20).toISOString(), kind: 'onsite', round: 'Panel', locationOrLink: 'Hooli HQ, Oakland' });
      store.addTask(ids['screening-1'], { title: 'Prep panel presentation', dueAt: inDays(3, 16).toISOString() });
    }
    if (ids['offer-1']) store.addArtifact(ids['offer-1'], 'resume_pdf', resume, {}, ago(1));
  } finally { store.close(); }
  return ids;
}
