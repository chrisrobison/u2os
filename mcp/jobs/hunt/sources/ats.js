import { buildSighting, getJson, plain, salaryRange } from './common.js';

// Board descriptions carry boilerplate addresses (accommodations, privacy, HR) that are not invitations to
// apply, so no contact emails are taken from them: a board job is applied to through its form.
const NO_CONTACTS = { contactEmails: [] };

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

// A venture firm's or accelerator's job board lists jobs at its portfolio companies. The company is the employer, which
// these boards put in the posting's department (Pear's Elo role has department "Elo"), or failing that after a dash in the title.
export const PORTFOLIO_BOARD = /(^|[-_.])(pear[-_]?vc|pearvc|a16z|andreessen|sequoia|accel|greylock|khosla|lightspeed|foundersfund|founders[-_]fund|indexventures|initialized|obvious|soma|yc|ycombinator|techstars|antler|500|vc|ventures?|capital|partners|fund|studios?|accelerator)($|[-_.])/i;

export function employerFromTitle(title) {
  const match = String(title ?? '').match(/\s[-\u2013\u2014@|]\s*([A-Z][^-\u2013\u2014@|]{1,40})$/);
  return match ? match[1].trim() : null;
}

export function companyFor(slug, job, fallback) {
  if (!PORTFOLIO_BOARD.test(slug)) return fallback;
  const department = String(job.department ?? job.team ?? '').trim();
  const clean = (name) => (name && name.length <= 60 && !/^(engineering|product|design|operations|sales|marketing|general|other|jobs?)$/i.test(name) ? name : null);
  return clean(department) ?? clean(employerFromTitle(job.title)) ?? fallback;
}

function greenhouse(slug, job) {
  const company = job.company_name || slug;
  const range = (job.pay_input_ranges ?? [])[0];
  const text = plain(job.content);
  return buildSighting({
    source: 'greenhouse', sourceKey: `greenhouse:${slug}:${job.id}`, company: companyFor(slug, { department: job.departments?.[0]?.name, title: job.title }, company), role: job.title,
    text, locations: [job.location?.name, ...(job.offices ?? []).map((office) => office.name)].filter(Boolean),
    salary: range ? salaryRange(Number(range.min_cents) / 100, Number(range.max_cents) / 100, range.currency_type) : undefined,
    applicationUrl: job.absolute_url, sourceUrl: job.absolute_url, postedAt: job.first_published || job.updated_at || null,
    extra: { sourceThread: slug }, ...NO_CONTACTS,
  });
}

function lever(slug, job) {
  const body = [job.descriptionPlain, ...(job.lists ?? []).map((list) => `${list.text}\n${plain(list.content)}`), job.additionalPlain].filter(Boolean).join('\n\n');
  const locations = [job.categories?.location, ...(job.categories?.allLocations ?? [])].filter(Boolean);
  const range = job.salaryRange;
  return buildSighting({
    source: 'lever', sourceKey: `lever:${slug}:${job.id}`, company: companyFor(slug, { department: job.categories?.team, title: job.text }, slug.replace(/[-_]/g, ' ')), role: job.text,
    text: body, locations,
    remote: job.workplaceType === 'remote' ? true : job.workplaceType === 'onsite' ? false : undefined,
    salary: range ? salaryRange(range.min, range.max, range.currency) : undefined,
    applicationUrl: job.applyUrl || job.hostedUrl, sourceUrl: job.hostedUrl, postedAt: job.createdAt ? new Date(Number(job.createdAt)).toISOString() : null,
    extra: { sourceThread: slug }, ...NO_CONTACTS,
  });
}

function ashby(slug, job) {
  const comp = job.compensation?.compensationTierSummary;
  const body = `${plain(job.descriptionHtml) || job.descriptionPlain || ''}${comp ? `\n\nCompensation: ${comp}` : ''}`;
  return buildSighting({
    source: 'ashby', sourceKey: `ashby:${slug}:${job.id}`, company: companyFor(slug, job, slug.replace(/[-_.]/g, ' ')), role: job.title,
    text: body, locations: [job.location, ...(job.secondaryLocations ?? []).map((entry) => entry.location)].filter(Boolean),
    remote: job.isRemote === true || job.workplaceType === 'Remote' ? true : job.workplaceType === 'OnSite' ? false : undefined,
    applicationUrl: job.applyUrl || job.jobUrl, sourceUrl: job.jobUrl, postedAt: job.publishedAt || null,
    extra: { sourceThread: slug }, ...NO_CONTACTS,
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
