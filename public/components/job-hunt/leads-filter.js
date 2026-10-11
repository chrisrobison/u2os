// Which Job Leads belong under "Needs you". DOM-free so it can be tested.

/**
 * A job needs the owner when its status says so (form applications that stopped on a question the facts do not
 * cover have no email draft) or when its email draft lists asks the facts do not cover.
 */
export function needsOwner(job) {
  return job.status === 'needs_input' || Boolean(job.draft?.needsInput?.length);
}

/** The ranked list plus extra jobs it did not reach (ranked beyond its limit), without duplicates, best score first. */
export function mergeJobs(jobs, extra = []) {
  const seen = new Set(jobs.map((job) => job.id));
  const added = extra.filter((job) => !seen.has(job.id));
  if (!added.length) return jobs;
  return [...jobs, ...added].sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1));
}
