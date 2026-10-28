import fs from 'node:fs';
import { OVERVIEW_STAGES, STRONG_MATCH_SCORE, attentionItems, overviewStageOf } from './overview.js';
import { JOB_STATUSES } from './storage/store.js';

// The Opportunities table's query (#631, part of #626): one paged, filtered,
// searched and sorted list of jobs, with a count for every quick filter. All
// filtering, searching, sorting and paging happens in SQL (parameterised, LIKE
// wildcards escaped); the two filters that are not a plain status test (Needs
// Input and Ready to Apply) are computed from the same rules the Overview and
// Job Leads use and handed to SQL as a bound JSON list of job ids. Documented in
// docs/job-hunt.md ("Opportunities").

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
const MAX_PAGE = 100_000;
const MAX_SEARCH_LENGTH = 200;
const MAX_TERMS = 5;
const MAX_LIST = 12; // skills / locations returned per row

const stageStatuses = (...ids) => OVERVIEW_STAGES.filter((stage) => ids.includes(stage.id)).flatMap((stage) => stage.statuses);

/**
 * The quick filters, in tab order. A filter is a status list (the Overview stage mapping, so counts agree with the
 * Overview) or a computed id set (`ids`).
 *  - Applied: the Submitted stage (applied, contacted, followup_due).
 *  - Responded: the employer has answered: the Responded, Interviewing and Offer stages.
 *  - Archived: left the pipeline on purpose (rejected, withdrawn, closed, skipped). error / uncertain are in All only.
 */
export const QUICK_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'needs_input', label: 'Needs Input', ids: 'needs_input' },
  { id: 'ready', label: 'Ready to Apply', ids: 'ready' },
  { id: 'applied', label: 'Applied', statuses: stageStatuses('submitted') },
  { id: 'responded', label: 'Responded', statuses: stageStatuses('responded', 'interviewing', 'offer') },
  { id: 'archived', label: 'Archived', statuses: ['rejected', 'withdrawn', 'closed', 'skipped'] },
];

// Ready to Apply starts from Job Leads' "Ready to send" (a prepared draft with nothing left to ask the owner and no
// application email in flight) and keeps only jobs still before submission and not waiting on the owner.
const READY_STATUSES = stageStatuses('discovered', 'qualified', 'preparing').filter((status) => status !== 'needs_input');
const ACTIVE_EMAIL = ['proposing', 'proposed', 'sent', 'uncertain'];

const STAGE_IDS = OVERVIEW_STAGES.map((stage) => stage.id);

const POSTED = '(SELECT MAX(posted_at) FROM job_sources WHERE job_id = j.id)';
const SORTS = {
  fit: { expr: 's.score', dir: 'desc' },
  company: { expr: 'j.company COLLATE NOCASE', dir: 'asc' },
  role: { expr: "NULLIF(j.role, '') COLLATE NOCASE", dir: 'asc' },
  status: { expr: 'j.status', dir: 'asc' },
  posted: { expr: POSTED, dir: 'desc' },
  seen: { expr: 'j.first_seen_at', dir: 'desc' },
};
export const SORT_IDS = Object.keys(SORTS);

const bad = (message) => Object.assign(new Error(message), { code: 'BAD_INPUT' });

/** Escapes LIKE wildcards (and the escape character) so a search is always a literal substring. */
export const escapeLike = (text) => String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);

const single = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * Validates the query string (strings in, normalised object out). Unknown enumerations are a 400 (BAD_INPUT), numbers
 * are clamped. Defaults: filter all, sort fit descending, page 1, 25 per page.
 */
export function parseOpportunitiesQuery(query = {}) {
  const get = (key) => { const value = single(query[key]); return value == null ? '' : String(value); };
  const filter = get('filter') || 'all';
  if (!QUICK_FILTERS.some((entry) => entry.id === filter)) throw bad(`filter must be one of ${QUICK_FILTERS.map((entry) => entry.id).join(', ')}`);
  const stage = get('stage') || null;
  if (stage && !STAGE_IDS.includes(stage)) throw bad(`stage must be one of ${STAGE_IDS.join(', ')}`);
  const statuses = get('statuses') ? [...new Set(get('statuses').split(',').filter(Boolean))] : null;
  if (statuses && (statuses.length > JOB_STATUSES.length || statuses.some((status) => !JOB_STATUSES.includes(status)))) throw bad('statuses must be a comma-separated list of job statuses');
  const sort = get('sort') || 'fit';
  if (!Object.hasOwn(SORTS, sort)) throw bad(`sort must be one of ${SORT_IDS.join(', ')}`);
  const dir = get('dir') || SORTS[sort].dir;
  if (dir !== 'asc' && dir !== 'desc') throw bad('dir must be asc or desc');
  let minScore = null;
  if (get('min_score') !== '') {
    minScore = Number(get('min_score'));
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw bad('min_score must be a number from 0 to 100');
  }
  const wholeNumber = (key, fallback, min, max) => {
    if (get(key) === '') return fallback;
    const value = Number(get(key));
    if (!Number.isInteger(value)) throw bad(`${key} must be a whole number`);
    return Math.min(max, Math.max(min, value));
  };
  const q = get('q').trim().slice(0, MAX_SEARCH_LENGTH);
  return {
    filter, stage, statuses, sort, dir, minScore,
    remote: get('remote') === '1' || get('remote') === 'true',
    q,
    page: wholeNumber('page', 1, 1, MAX_PAGE),
    limit: wholeNumber('limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
  };
}

// ---- computed filters ---------------------------------------------------------

const draftCache = new Map(); // `${path}|${sha256}` -> needsInput count; a draft file is immutable per hash

function draftHasAsks(path, sha256) {
  const key = `${path}|${sha256}`;
  if (!draftCache.has(key)) {
    let asks = 0;
    try { asks = (JSON.parse(fs.readFileSync(path, 'utf8')).needsInput ?? []).length; } catch { asks = 0; }
    if (draftCache.size > 5000) draftCache.clear();
    draftCache.set(key, asks);
  }
  return draftCache.get(key) > 0;
}

function readyIds(store, attention) {
  const marks = (list) => list.map(() => '?').join(',');
  const rows = store.db.prepare(`SELECT a.job_id, a.path, a.sha256 FROM artifacts a JOIN jobs j ON j.id = a.job_id
    WHERE a.kind = 'email_json' AND a.id IN (SELECT MAX(id) FROM artifacts WHERE kind = 'email_json' GROUP BY job_id)
      AND j.status IN (${marks(READY_STATUSES)})
      AND j.id NOT IN (SELECT job_id FROM emails WHERE kind = 'application' AND status IN (${marks(ACTIVE_EMAIL)}))`).all(...READY_STATUSES, ...ACTIVE_EMAIL);
  return rows.filter((row) => !attention.has(row.job_id) && !draftHasAsks(row.path, row.sha256)).map((row) => row.job_id);
}

// ---- SQL ----------------------------------------------------------------------

/** WHERE fragments shared by the page and every count: search, fit floor, remote, stage and status scope. */
function facetClauses(query, sets) {
  const where = []; const params = [];
  for (const term of query.q.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS)) {
    const like = `%${escapeLike(term)}%`;
    const list = (column) => `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END) WHERE CAST(value AS TEXT) LIKE ? ESCAPE '\\')`;
    where.push(`(j.company LIKE ? ESCAPE '\\' OR j.role LIKE ? ESCAPE '\\' OR ${list('j.locations')} OR ${list('j.technologies')})`);
    params.push(like, like, like, like);
  }
  if (query.minScore != null) { where.push('s.score >= ?'); params.push(query.minScore); }
  if (query.remote) where.push('j.remote = 1');
  if (query.stage === 'needs_input') { where.push('j.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(sets.needs_input)); }
  else if (query.stage) {
    const statuses = stageStatuses(query.stage);
    where.push(`j.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses);
  }
  if (query.statuses) { where.push(`j.status IN (${query.statuses.map(() => '?').join(',')})`); params.push(...query.statuses); }
  return { where, params };
}

function quickClause(entry, sets) {
  if (entry.ids) return { sql: 'j.id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(sets[entry.ids])] };
  if (entry.statuses) return { sql: `j.status IN (${entry.statuses.map(() => '?').join(',')})`, params: entry.statuses };
  return null;
}

const list = (text) => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; } };
const strings = (values) => values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()).slice(0, MAX_LIST);
const salaryOf = (text) => { try { const raw = JSON.parse(text)?.raw; return typeof raw === 'string' && raw.trim() ? raw.trim() : null; } catch { return null; } };

/**
 * One page of jobs plus the count of every quick filter. `counts` apply the search, fit floor, remote, stage and
 * status scope but not the quick filter itself, so the active tab's count always equals `total`. Items carry only
 * what the store has; a missing value is null.
 */
export function queryOpportunities(store, rawQuery = {}, { now = new Date() } = {}) {
  const query = parseOpportunitiesQuery(rawQuery);
  const attention = new Set(attentionItems(store, { now }).map((item) => item.jobId));
  const sets = { needs_input: [...attention], ready: readyIds(store, attention) };
  const facets = facetClauses(query, sets);
  const base = 'FROM jobs j LEFT JOIN job_scores s ON s.job_id = j.id';
  const countFor = (entry) => {
    const quick = quickClause(entry, sets);
    const where = [...facets.where, ...(quick ? [quick.sql] : [])];
    const params = [...facets.params, ...(quick?.params ?? [])];
    return Number(store.db.prepare(`SELECT COUNT(*) AS n ${base}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).get(...params).n);
  };
  const counts = Object.fromEntries(QUICK_FILTERS.map((entry) => [entry.id, countFor(entry)]));
  const total = counts[query.filter];

  const active = QUICK_FILTERS.find((entry) => entry.id === query.filter);
  const quick = quickClause(active, sets);
  const where = [...facets.where, ...(quick ? [quick.sql] : [])];
  const params = [...facets.params, ...(quick?.params ?? [])];
  const sort = SORTS[query.sort];
  const direction = query.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = store.db.prepare(`SELECT j.id, j.company, j.role, j.locations, j.remote, j.salary, j.technologies, j.status, j.first_seen_at,
      s.score AS score, s.label AS score_label, ${POSTED} AS posted_at ${base}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (${sort.expr} IS NULL), ${sort.expr} ${direction}, j.id ASC LIMIT ? OFFSET ?`).all(...params, query.limit, (query.page - 1) * query.limit);

  const items = rows.map((row) => ({
    id: row.id, company: row.company, role: row.role || null,
    locations: strings(list(row.locations)), remote: row.remote == null ? null : Boolean(row.remote),
    compensation: salaryOf(row.salary), skills: strings(list(row.technologies)),
    status: row.status, stage: overviewStageOf(row.status), needsInput: attention.has(row.id),
    fit: row.score ?? null, fitLabel: row.score_label ?? null,
    postedAt: row.posted_at ?? null, firstSeenAt: row.first_seen_at,
  }));
  return {
    items, total, page: query.page, limit: query.limit, counts,
    query: { filter: query.filter, stage: query.stage, statuses: query.statuses, q: query.q, sort: query.sort, dir: query.dir, minScore: query.minScore, remote: query.remote },
    strongMatchScore: STRONG_MATCH_SCORE,
  };
}
