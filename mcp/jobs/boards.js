// Public job-board APIs: Greenhouse and Lever publish every open posting of
// a company as JSON without login. Applications are made on the boards'
// own hosted forms (apply.js); form URLs are always built here from board
// and job ids, never taken from a model or from posting content.

export const JOB_ID = /^(greenhouse|lever):([A-Za-z0-9_.-]{1,80}):([A-Za-z0-9-]{1,80})$/;
const MAX_DESCRIPTION = 1_500;

export function endpoints(env = process.env) {
  return {
    greenhouseApi: env.JOBS_GREENHOUSE_API || 'https://boards-api.greenhouse.io',
    greenhouseBoard: env.JOBS_GREENHOUSE_BOARD || 'https://job-boards.greenhouse.io',
    leverApi: env.JOBS_LEVER_API || 'https://api.lever.co',
    leverJobs: env.JOBS_LEVER_JOBS || 'https://jobs.lever.co',
  };
}

export function parseJobId(jobId) {
  const match = typeof jobId === 'string' && jobId.match(JOB_ID);
  if (!match) throw new Error('job_id must be an id returned by search_jobs, such as greenhouse:acme:12345');
  return { ats: match[1], board: match[2], id: match[3] };
}

export function applicationUrl({ ats, board, id }, urls = endpoints()) {
  return ats === 'greenhouse'
    ? `${urls.greenhouseBoard}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`
    : `${urls.leverJobs}/${encodeURIComponent(board)}/${encodeURIComponent(id)}/apply`;
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

/** All open postings on one board, normalized. */
export async function fetchBoard(boardSpec, { urls = endpoints(), fetchImpl = fetch } = {}) {
  const [ats, board] = boardSpec.split(':');
  if (ats === 'greenhouse') {
    const [info, list] = await Promise.all([
      getJson(`${urls.greenhouseApi}/v1/boards/${encodeURIComponent(board)}`, fetchImpl).catch(() => null),
      getJson(`${urls.greenhouseApi}/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, fetchImpl),
    ]);
    if (!list) throw new Error(`Greenhouse board "${board}" was not found`);
    const company = info?.name || board;
    return (list.jobs || []).map((job) => ({
      job_id: `greenhouse:${board}:${job.id}`,
      company,
      title: String(job.title || ''),
      location: String(job.location?.name || ''),
      remote: /remote/i.test(job.location?.name || ''),
      department: job.departments?.[0]?.name || null,
      updated_at: job.updated_at || null,
      url: job.absolute_url || applicationUrl({ ats, board, id: job.id }, urls),
      description: plainText(decodeEntities(job.content || '')).slice(0, MAX_DESCRIPTION),
    }));
  }
  const list = await getJson(`${urls.leverApi}/v0/postings/${encodeURIComponent(board)}?mode=json`, fetchImpl);
  if (!list) throw new Error(`Lever company "${board}" was not found`);
  return list.map((job) => ({
    job_id: `lever:${board}:${job.id}`,
    company: board,
    title: String(job.text || ''),
    location: String(job.categories?.location || ''),
    remote: job.workplaceType === 'remote' || /remote/i.test(job.categories?.location || ''),
    department: job.categories?.team || null,
    updated_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    url: job.hostedUrl || applicationUrl({ ats, board, id: job.id }, urls),
    salary: job.salaryRange ? `${job.salaryRange.min ?? '?'}-${job.salaryRange.max ?? '?'} ${job.salaryRange.currency || ''} ${job.salaryRange.interval || ''}`.trim() : null,
    description: String(job.descriptionPlain || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION),
  }));
}

/** Greenhouse publishes each posting's application questions. Lever's are discovered on the form. */
export async function fetchQuestions(jobId, { urls = endpoints(), fetchImpl = fetch } = {}) {
  const { ats, board, id } = parseJobId(jobId);
  if (ats !== 'greenhouse') return null;
  const job = await getJson(`${urls.greenhouseApi}/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?questions=true`, fetchImpl);
  if (!job) return null;
  return (job.questions || []).flatMap((question) => (question.fields || []).map((field) => ({
    name: field.name,
    label: String(question.label || ''),
    required: question.required === true,
    type: field.type,
    ...(Array.isArray(field.values) && field.values.length ? { options: field.values.map((value) => String(value.label)) } : {}),
  })));
}

/** Whether the posting is still open, with its title and company. */
export async function fetchPosting(jobId, options = {}) {
  const { ats, board } = parseJobId(jobId);
  const postings = await fetchBoard(`${ats}:${board}`, options);
  return postings.find((posting) => posting.job_id === jobId) || null;
}

export function matches(posting, { keywords = [], locations = [], remote = false }) {
  const title = posting.title.toLowerCase();
  if (keywords.length && !keywords.some((keyword) => title.includes(String(keyword).toLowerCase()))) return false;
  if (!locations.length) return true;
  const place = posting.location.toLowerCase();
  return (remote && posting.remote) || locations.some((location) => place.includes(String(location).toLowerCase()));
}

function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function plainText(html) {
  // Greenhouse escapes its HTML once more, so entities are decoded again after the tags are gone.
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
