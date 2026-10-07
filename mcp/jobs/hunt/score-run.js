import { scoreJob } from './jobs/scorer.js';
import { candidateDigest } from './candidate/profile.js';

/** Scores jobs that have not been scored yet (or all, with `rescore`). */
export async function scoreJobs({ store, resume, preferences, repos = [], llm = null, rescore = false, limit = null, company = null, role = null, concurrency = 2, now = new Date(), onProgress = () => {} }) {
  const candidate = { resume, preferences, repos, digest: candidateDigest(resume, preferences) };
  let jobs = store.listJobs({ company, limit: 5000 }).filter((job) => ['discovered', 'scored'].includes(job.status));
  if (!rescore) jobs = jobs.filter((job) => !store.getScore(job.id));
  if (role) jobs = jobs.filter((job) => String(job.role ?? '').toLowerCase().includes(role.toLowerCase()));
  if (limit) jobs = jobs.slice(0, limit);
  const summary = { examined: jobs.length, scored: 0, degraded: 0, errors: [], byLabel: {} };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const source = store.listSources(job.id)[0] ?? null;
        const result = await scoreJob({ job, source, candidate, llm });
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
