import { parseComment } from '../jobs/parser.js';

// Hacker News "Ask HN: Who is hiring? (Month YYYY)", posted monthly by the
// whoishiring account. The thread is found by searching for it, never by a
// fixed id. Algolia's public HN API returns the whole comment tree at once.

export const DEFAULT_API = 'https://hn.algolia.com/api/v1';
const TITLE = /^Ask HN: Who is hiring\?\s*\(([A-Za-z]+) (\d{4})\)\s*$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseThreadTitle(title) {
  const match = String(title ?? '').match(TITLE);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  return month < 0 ? null : { month: month + 1, year: Number(match[2]), label: `${match[1]} ${match[2]}` };
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'u2os-job-hunter' } });
  if (!response.ok) throw new Error(`Hacker News API ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

/** The newest Who-is-hiring thread, or the one for `month` ("October 2026"). */
export async function findThread({ fetch: fetchImpl = fetch, api = DEFAULT_API, month = null } = {}) {
  const query = month ? `Ask HN: Who is hiring? (${month})` : 'Ask HN: Who is hiring?';
  const url = `${api}/search_by_date?${new URLSearchParams({ query, tags: 'story,author_whoishiring', hitsPerPage: '20' })}`;
  const { hits = [] } = await getJson(fetchImpl, url);
  const threads = hits
    .map((hit) => ({ id: String(hit.objectID), title: hit.title, createdAt: hit.created_at, author: hit.author, ...parseThreadTitle(hit.title) }))
    .filter((thread) => thread.label && (!month || thread.label.toLowerCase() === month.toLowerCase()))
    .sort((a, b) => b.year - a.year || b.month - a.month || String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!threads.length) throw new Error(month ? `No "Who is hiring? (${month})" thread found` : 'No "Who is hiring?" thread found');
  return threads[0];
}

/** Top-level comments of a thread. */
export async function fetchComments(threadId, { fetch: fetchImpl = fetch, api = DEFAULT_API } = {}) {
  const item = await getJson(fetchImpl, `${api}/items/${encodeURIComponent(threadId)}`);
  return Array.isArray(item.children) ? item.children : [];
}

/**
 * Fetches and parses the thread. Returns the thread, the structured jobs and
 * the comments that were not listings (with the reason, for the audit trail).
 */
export async function discoverHackerNews({ fetch: fetchImpl = fetch, api = DEFAULT_API, month = null, now = new Date(), limit = null } = {}) {
  const thread = await findThread({ fetch: fetchImpl, api, month });
  const comments = await fetchComments(thread.id, { fetch: fetchImpl, api });
  const jobs = [];
  const skipped = [];
  for (const comment of limit ? comments.slice(0, limit) : comments) {
    const result = parseComment(comment, { threadId: thread.id, now });
    jobs.push(...result.jobs);
    if (result.skipped) skipped.push({ comment: String(comment.id), reason: result.skipped });
  }
  return { thread, comments: comments.length, jobs, skipped };
}
