import fs from 'node:fs';
import path from 'node:path';
import { chooseStrategy } from './applications/strategy.js';

// What the Job hunt page and API show for one job: the facts, the score and
// why, the approach, the draft email and what has happened to it. No secrets,
// no file contents beyond the owner's own draft text.

function readDraft(artifact) {
  if (!artifact) return null;
  try {
    const draft = JSON.parse(fs.readFileSync(artifact.path, 'utf8'));
    return { to: draft.to, subject: draft.subject, text: draft.text, attachments: (draft.attachments ?? []).map((ref) => String(ref).split('/').pop()), needsInput: draft.needsInput ?? [] };
  } catch { return null; }
}

export function jobView(store, job, { minimumScore = 82, detail = false } = {}) {
  const score = store.getScore(job.id);
  const artifacts = store.getArtifacts(job.id);
  const strategy = chooseStrategy(job, { score, minimumScore });
  const view = {
    id: job.id, company: job.company, role: job.role, status: job.status, locations: job.locations, remote: job.remote, salary: job.salary?.raw ?? null,
    technologies: job.technologies, contactEmails: job.contactEmails, applicationUrls: job.applicationUrls, companyUrl: job.companyUrl, firstSeenAt: job.firstSeenAt,
    score: score ? { score: score.score, label: score.label, confidence: score.confidence, degraded: score.degraded, narrative: score.recommendedNarrative, reasons: score.reasons, concerns: score.concerns, projects: score.projects, flags: score.flags } : null,
    strategy: { name: strategy.strategy, reason: strategy.reason },
    draft: readDraft(artifacts.email_json),
    materials: Object.keys(artifacts).filter((kind) => kind !== 'email_json').map((kind) => ({ kind, file: path.basename(artifacts[kind].path) })),
    emails: store.listEmails(job.id).map((email) => ({ id: email.id, kind: email.kind, to: email.to, status: email.status, actionId: email.actionId, updatedAt: email.updatedAt, followUpAfter: email.detail?.followUpAfter ?? null })),
  };
  if (detail) {
    view.sources = store.listSources(job.id).map((source) => ({ source: source.source, author: source.author, url: source.sourceUrl, postedAt: source.postedAt, rawText: source.rawText }));
    view.dimensions = score?.dimensions ?? {};
    view.events = store.listEvents(job.id);
  }
  return view;
}

/** Scored jobs, best first, then unscored with materials; optionally filtered. */
export function listJobViews(store, { minScore = null, status = null, limit = 200, minimumScore = 82 } = {}) {
  return store.listScored({ minScore, limit: 5000 })
    .filter(({ job }) => !status || job.status === status)
    .slice(0, limit)
    .map(({ job }) => jobView(store, job, { minimumScore }));
}
