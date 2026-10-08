import { ruleBasedScore, scoreJob } from './jobs/scorer.js';
import { candidateDigest } from './candidate/profile.js';

/** Scores jobs that have not been scored yet (or all, with `rescore`). */
export const DEFAULT_PREFILTER = 55;

export async function scoreJobs({ store, resume, preferences, repos = [], llm = null, rescore = false, limit = null, company = null, role = null, concurrency = 2, prefilter = DEFAULT_PREFILTER, onlyDegraded = false, now = new Date(), onProgress = () => {} }) {
  const candidate = { resume, preferences, repos, digest: candidateDigest(resume, preferences) };
  let jobs = store.listJobs({ company, limit: 5000 }).filter((job) => ['discovered', 'scored'].includes(job.status));
  if (!rescore) jobs = jobs.filter((job) => !store.getScore(job.id));
  // Sends only jobs that currently have a rule-scored (degraded) score back through the model.
  if (onlyDegraded) jobs = jobs.filter((job) => store.getScore(job.id)?.degraded);
  if (role) jobs = jobs.filter((job) => String(job.role ?? '').toLowerCase().includes(role.toLowerCase()));
  // Best first by the cheap rule estimate, so a limit (or an interrupted run) spends model calls on the most promising jobs.
  const estimates = new Map(jobs.map((job) => [job.id, ruleBasedScore(job, { resume, preferences, repos })]));
  jobs.sort((a, b) => estimates.get(b.id).score - estimates.get(a.id).score);
  if (limit) jobs = jobs.slice(0, limit);
  const summary = { examined: jobs.length, scored: 0, degraded: 0, screened: 0, errors: [], byLabel: {} };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const source = store.listSources(job.id)[0] ?? null;
        // Cheap rules first: only plausible jobs are worth a model call. A screened-out job keeps its (degraded,
        // never auto-qualifying) rule score and can be sent to the model later with --rescore --prefilter 0.
        let result = null;
        if (prefilter > 0 && llm?.available) {
          const estimate = ruleBasedScore(job, { resume, preferences, repos });
          if (estimate.score < prefilter) {
            result = { ...estimate, concerns: [...estimate.concerns, `Screened out by rules (${estimate.score} < ${prefilter}); rescore with --rescore --prefilter 0 to use the model`].slice(-8) };
            summary.screened += 1;
          }
        }
        result ??= await scoreJob({ job, source, candidate, llm });
        store.saveScore(job.id, result, now);
        summary.scored += 1;
        if (result.degraded) summary.degraded += 1;
        summary.byLabel[result.label] = (summary.byLabel[result.label] ?? 0) + 1;
        onProgress({ job, result, done: summary.scored + summary.errors.length, total: jobs.length });
      } catch (error) {
        summary.errors.push({ jobId: job.id, company: job.company, error: String(error.message).slice(0, 200) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 4)) }, worker));
  return summary;
}
