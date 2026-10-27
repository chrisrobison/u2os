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

/** The orders Job Leads offers: [id, label, natural direction]. Text sorts A-Z first; score and date, biggest or newest first. */
export const SORTS = [['score', 'Score', 'desc'], ['newest', 'Newest', 'desc'], ['company', 'Company', 'asc'], ['role', 'Role', 'asc'], ['status', 'Status', 'asc']];

const KEYS = {
  score: (job) => job.score?.score ?? null,
  newest: (job) => (job.firstSeenAt ? Date.parse(job.firstSeenAt) || null : null),
  company: (job) => (job.company || '').trim().toLowerCase() || null,
  role: (job) => (job.role || '').trim().toLowerCase() || null,
  status: (job) => job.status || null,
};

/**
 * A sorted copy. A job with no value for the key goes last in either direction; ties keep the incoming order
 * (which is best score first), so every sort is stable and predictable.
 */
export function sortJobs(jobs, sort = 'score', direction = null) {
  const entry = SORTS.find(([id]) => id === sort) ?? SORTS[0];
  const sign = (direction ?? entry[2]) === 'asc' ? 1 : -1;
  const key = KEYS[entry[0]];
  return jobs.map((job, index) => ({ job, index, value: key(job) })).sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
    const order = typeof a.value === 'string' ? a.value.localeCompare(b.value) : a.value - b.value;
    return order ? order * sign : a.index - b.index;
  }).map((entry2) => entry2.job);
}
