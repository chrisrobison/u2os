import { buildSighting, getJson, plain, salaryRange } from './common.js';

// Company job boards on the three common applicant-tracking systems. Each
// publishes its open jobs as a public JSON API intended for exactly this.
// A board is named `kind:slug`, e.g. greenhouse:anthropic, lever:palantir,
// ashby:ramp.

export const BOARD = /^(greenhouse|lever|ashby):[A-Za-z0-9_.-]{1,80}$/;
export const API = {
  greenhouse: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  lever: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  ashby: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
};

export function parseBoard(name) {
  if (!BOARD.test(String(name))) throw new Error(`Board "${name}" must look like greenhouse:<board>, lever:<company> or ashby:<board>`);
  const [kind, slug] = name.split(':');
  return { kind, slug };
}

function greenhouse(slug, job) {
  const company = job.company_name || slug;
  const range = (job.pay_input_ranges ?? [])[0];
  const text = plain(job.content);
  return buildSighting({
    source: 'greenhouse', sourceKey: `greenhouse:${slug}:${job.id}`, company, role: job.title,
    text, locations: [job.location?.name, ...(job.offices ?? []).map((office) => office.name)].filter(Boolean),
    salary: range ? salaryRange(Number(range.min_cents) / 100, Number(range.max_cents) / 100, range.currency_type) : undefined,
    applicationUrl: job.absolute_url, sourceUrl: job.absolute_url, postedAt: job.first_published || job.updated_at || null,
    extra: { sourceThread: slug },
  });
}

function lever(slug, job) {
  const body = [job.descriptionPlain, ...(job.lists ?? []).map((list) => `${list.text}\n${plain(list.content)}`), job.additionalPlain].filter(Boolean).join('\n\n');
  const locations = [job.categories?.location, ...(job.categories?.allLocations ?? [])].filter(Boolean);
  const range = job.salaryRange;
  return buildSighting({
    source: 'lever', sourceKey: `lever:${slug}:${job.id}`, company: slug.replace(/[-_]/g, ' '), role: job.text,
    text: body, locations,
    remote: job.workplaceType === 'remote' ? true : job.workplaceType === 'onsite' ? false : undefined,
    salary: range ? salaryRange(range.min, range.max, range.currency) : undefined,
    applicationUrl: job.applyUrl || job.hostedUrl, sourceUrl: job.hostedUrl, postedAt: job.createdAt ? new Date(Number(job.createdAt)).toISOString() : null,
    extra: { sourceThread: slug },
  });
}

function ashby(slug, job) {
  const comp = job.compensation?.compensationTierSummary;
  const body = `${plain(job.descriptionHtml) || job.descriptionPlain || ''}${comp ? `\n\nCompensation: ${comp}` : ''}`;
  return buildSighting({
    source: 'ashby', sourceKey: `ashby:${slug}:${job.id}`, company: slug.replace(/[-_.]/g, ' '), role: job.title,
    text: body, locations: [job.location, ...(job.secondaryLocations ?? []).map((entry) => entry.location)].filter(Boolean),
    remote: job.isRemote === true || job.workplaceType === 'Remote' ? true : job.workplaceType === 'OnSite' ? false : undefined,
    applicationUrl: job.applyUrl || job.jobUrl, sourceUrl: job.jobUrl, postedAt: job.publishedAt || null,
    extra: { sourceThread: slug },
  });
}

/** Open jobs on one board, as sightings. A board that does not exist yields []. */
export async function fetchBoard(name, { fetch: fetchImpl = fetch } = {}) {
  const { kind, slug } = parseBoard(name);
  const data = await getJson(fetchImpl, API[kind](slug));
  if (data === null) return [];
  const jobs = kind === 'greenhouse' ? data.jobs : kind === 'ashby' ? data.jobs?.filter((job) => job.isListed !== false) : data;
  if (!Array.isArray(jobs)) throw new Error(`${name}: unexpected response`);
  const convert = { greenhouse, lever, ashby }[kind];
  return jobs.map((job) => convert(slug, job));
}
