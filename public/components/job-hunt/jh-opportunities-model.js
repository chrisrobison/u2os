import { formatDay, titleCase } from './jh-util.js';

// Pure helpers for the Opportunities table (#631): the URL/query state, status labels and cell text. DOM-free so they
// can be tested. The same parameter names are used in the page URL and in GET /api/job-hunt/opportunities.

export const OPPORTUNITIES_ROUTE = '#/job-hunt/opportunities';
export const PAGE_SIZE = 25;
export const MAX_SEARCH = 200;

/** The quick filters, in tab order (mirrors QUICK_FILTERS in mcp/jobs/hunt/opportunities.js). */
export const FILTER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'needs_input', label: 'Needs Input' },
  { id: 'ready', label: 'Ready to Apply' },
  { id: 'applied', label: 'Applied' },
  { id: 'responded', label: 'Responded' },
  { id: 'archived', label: 'Archived' },
];

/** The sort keys: [id, label, natural direction]. */
export const SORTS = [['fit', 'Best fit', 'desc'], ['company', 'Company', 'asc'], ['role', 'Role', 'asc'], ['status', 'Status', 'asc'], ['posted', 'Date posted', 'desc'], ['seen', 'First seen', 'desc']];

export const FIT_FLOORS = [[0, 'Any fit'], [60, '60 or higher'], [70, '70 or higher'], [80, '80 or higher (strong)'], [85, '85 or higher']];

const STAGES = ['discovered', 'qualified', 'preparing', 'submitted', 'responded', 'interviewing', 'offer'];
const STATUS_NAME = /^[a-z_]{1,32}$/;

export const naturalDir = (sort) => SORTS.find(([id]) => id === sort)?.[2] ?? 'desc';

export function defaultState() {
  return { filter: 'all', stage: null, statuses: null, q: '', sort: 'fit', dir: 'desc', minScore: null, remote: false, page: 1 };
}

/** The table state a URL asks for. Unknown or malformed values fall back to the defaults. */
export function parseOpportunitiesHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const state = defaultState();
  if (FILTER_TABS.some((tab) => tab.id === params.get('filter'))) state.filter = params.get('filter');
  if (STAGES.includes(params.get('stage')) || params.get('stage') === 'needs_input') state.stage = params.get('stage');
  const statuses = (params.get('statuses') ?? '').split(',').filter((status) => STATUS_NAME.test(status)).slice(0, 20);
  if (statuses.length) state.statuses = statuses;
  state.q = (params.get('q') ?? '').slice(0, MAX_SEARCH);
  if (SORTS.some(([id]) => id === params.get('sort'))) state.sort = params.get('sort');
  state.dir = params.get('dir') === 'asc' || params.get('dir') === 'desc' ? params.get('dir') : naturalDir(state.sort);
  const floor = Number(params.get('min_score'));
  if (params.get('min_score') && Number.isFinite(floor) && floor >= 0 && floor <= 100) state.minScore = floor || null;
  state.remote = params.get('remote') === '1';
  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page >= 1 && page <= 100_000) state.page = page;
  return state;
}

/** Only what differs from the defaults, so a plain table has a plain URL. */
function toParams(state) {
  const params = new URLSearchParams();
  if (state.filter && state.filter !== 'all') params.set('filter', state.filter);
  if (state.stage) params.set('stage', state.stage);
  if (state.statuses?.length) params.set('statuses', state.statuses.join(','));
  if (state.q) params.set('q', state.q);
  if (state.sort && state.sort !== 'fit') params.set('sort', state.sort);
  if (state.dir && state.dir !== naturalDir(state.sort || 'fit')) params.set('dir', state.dir);
  if (state.minScore) params.set('min_score', String(state.minScore));
  if (state.remote) params.set('remote', '1');
  if (state.page > 1) params.set('page', String(state.page));
  return params;
}

/** The page link for a (partial) state; the inverse of parseOpportunitiesHash. */
export function opportunitiesHref(partial = {}) {
  const full = { ...defaultState(), ...partial };
  if (!('dir' in partial)) full.dir = naturalDir(full.sort);
  const query = toParams(full).toString().replace(/%2C/g, ',');
  return `${OPPORTUNITIES_ROUTE}${query ? `?${query}` : ''}`;
}

/** The API query for a state (always explicit about sort, direction and page size). */
export function apiParams(state, limit = PAGE_SIZE) {
  const params = toParams(state);
  params.set('sort', state.sort);
  params.set('dir', state.dir);
  params.set('page', String(state.page));
  params.set('limit', String(limit));
  return Object.fromEntries(params.entries());
}

/** Anything besides the tab, sort and page that narrows the list (so an empty result can offer to clear it). */
export function hasNarrowing(state) {
  return Boolean(state.q || state.stage || state.statuses?.length || state.minScore || state.remote);
}

// ---- labels -------------------------------------------------------------------

/**
 * The owner-facing label and tone for every job status (docs/job-hunt.md, "Opportunities"). materials_generated reads
 * "Ready to apply": the application materials exist and the job waits for the owner or the autopilot.
 */
export const STATUS_LABELS = {
  discovered: ['neutral', 'Discovered'], scored: ['neutral', 'Scored'], researching: ['neutral', 'Researching'],
  qualified: ['active', 'Qualified'], materials_generated: ['agent', 'Ready to apply'], applying: ['agent', 'Applying'],
  needs_input: ['attention', 'Needs input'], applied: ['success', 'Applied'], contacted: ['success', 'Emailed'],
  followup_due: ['attention', 'Follow-up due'], screening: ['active', 'Recruiter screen'], interview: ['success', 'Interviewing'],
  offer: ['success', 'Offer'], rejected: ['danger', 'Rejected'], withdrawn: ['neutral', 'Withdrawn'], closed: ['neutral', 'Closed'],
  skipped: ['neutral', 'Skipped'], error: ['danger', 'Error'], uncertain: ['attention', 'Outcome unknown'],
};

/** [tone, label] for a row. A job that needs the owner but whose status does not say so shows "Needs input". */
export function statusOf(item) {
  const known = STATUS_LABELS[item.status];
  if (item.needsInput && (!known || !['attention', 'danger'].includes(known[0]))) return STATUS_LABELS.needs_input;
  return known ?? ['neutral', titleCase(item.status) || '—'];
}

export const DASH = '—';

export function locationText(item) {
  const parts = [...(item.locations ?? [])];
  if (item.remote === true && !parts.some((place) => /remote/i.test(place))) parts.push('Remote');
  return parts.length ? parts.slice(0, 3).join(' · ') : DASH;
}

export const compensationText = (item) => item.compensation || DASH;
export const postedText = (item) => (item.postedAt ? formatDay(item.postedAt) || DASH : DASH);
export const fitText = (item) => (typeof item.fit === 'number' ? String(item.fit) : DASH);

/** "26–50 of 4,059", or "0 results". */
export function rangeText(page, limit, total, shown) {
  if (!total || !shown) return '0 results';
  const from = (page - 1) * limit + 1;
  return `${from.toLocaleString('en-US')}–${(from + shown - 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

export const pageCount = (total, limit) => Math.max(1, Math.ceil(total / limit));

/** Clicking a sortable column: the same column reverses, a new one starts in its natural direction. */
export function nextSort(state, sort) {
  return sort === state.sort ? { sort, dir: state.dir === 'asc' ? 'desc' : 'asc' } : { sort, dir: naturalDir(sort) };
}

export const JOB_ID = /^job_[0-9a-f]{16}$/;
export const jobPageHref = (id) => (JOB_ID.test(String(id ?? '')) ? `#/job-hunt/jobs/${id}` : null);
