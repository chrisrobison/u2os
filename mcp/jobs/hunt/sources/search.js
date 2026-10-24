import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';
import { USER_AGENT } from './common.js';
import { boardFromUrl } from './boards.js';

// Finds company boards we have never heard of by running `site:` queries
//   site:jobs.ashbyhq.com "engineering manager" "San Francisco"
// against DuckDuckGo's HTML results page and reading the board out of each
// result URL. It only discovers boards; the board reader, relevance filter and
// scoring do the rest. DuckDuckGo has no supported search API, so this is
// deliberately small and polite: a few requests, spaced out. The first sign of
// a challenge or a non-200 answer stops the run, and nothing tries to get past
// one. Result text is untrusted data; only the URL's host and path are used.
//
// job-hunt/searches.yaml (every key optional):
//   titles: [engineering manager, director of engineering, staff engineer]
//   locations: [San Francisco, remote]
//   sites: [ashby, greenhouse, lever]
//   max_queries: 6         # per run; each run continues where the last stopped
//   max_boards: 30         # new boards crawled per run
//   delay_seconds: 8       # between queries

export const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const SITE_DOMAINS = Object.freeze({ ashby: 'jobs.ashbyhq.com', greenhouse: 'boards.greenhouse.io', lever: 'jobs.lever.co' });

export const SEARCH_DEFAULTS = Object.freeze({
  titles: ['engineering manager', 'director of engineering', 'staff engineer'],
  locations: ['San Francisco', 'remote'],
  sites: ['ashby', 'greenhouse', 'lever'],
  max_queries: 6, max_boards: 30, delay_seconds: 8,
});

export const searchesPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'searches.yaml');

const phrases = (value, name) => {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 80 || /["\n\r]/.test(item))) {
    throw new Error(`searches.yaml: ${name} must be a non-empty list of short phrases without quotes`);
  }
  return value.map((item) => item.trim());
};
const whole = (value, name, min, max, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`searches.yaml: ${name} must be a whole number from ${min} to ${max}`);
  return value;
};

export function loadSearchConfig(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(searchesPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('searches.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(searchesPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('searches.yaml must be a mapping');
  const sites = phrases(data.sites, 'sites') ?? [...SEARCH_DEFAULTS.sites];
  const bad = sites.find((site) => !SITE_DOMAINS[site]);
  if (bad) throw new Error(`searches.yaml: site "${bad}" must be one of ${Object.keys(SITE_DOMAINS).join(', ')}`);
  return {
    titles: phrases(data.titles, 'titles') ?? [...SEARCH_DEFAULTS.titles],
    locations: phrases(data.locations, 'locations') ?? [...SEARCH_DEFAULTS.locations],
    sites,
    max_queries: whole(data.max_queries, 'max_queries', 1, 100, SEARCH_DEFAULTS.max_queries),
    max_boards: whole(data.max_boards, 'max_boards', 1, 200, SEARCH_DEFAULTS.max_boards),
    delay_seconds: whole(data.delay_seconds, 'delay_seconds', 0, 120, SEARCH_DEFAULTS.delay_seconds),
  };
}

/** Every query: one per site, title and location. */
export function buildQueries(config = SEARCH_DEFAULTS) {
  const queries = [];
  for (const site of config.sites) for (const title of config.titles) for (const location of config.locations) {
    queries.push(`site:${SITE_DOMAINS[site]} "${title}" "${location}"`);
  }
  return queries;
}

// DuckDuckGo tolerates only a handful of queries at a time, so a run asks at
// most `max_queries` and the next run carries on from where this one stopped.
export const cursorPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'state', 'search-cursor.json');
export function loadCursor(vaultDir) {
  try { const { next } = JSON.parse(fs.readFileSync(cursorPath(vaultDir), 'utf8')); return Number.isInteger(next) && next >= 0 ? next : 0; } catch { return 0; }
}
export function saveCursor(vaultDir, next) {
  try { fs.mkdirSync(path.dirname(cursorPath(vaultDir)), { recursive: true }); fs.writeFileSync(cursorPath(vaultDir), `${JSON.stringify({ next })}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

const decode = (text) => text.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

/** Result URLs on a DuckDuckGo HTML results page; its redirect links are unwrapped. */
export function parseResultUrls(html) {
  const urls = [];
  for (const match of String(html).matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"/gi)) {
    const href = decode(match[1]);
    let target = href;
    try {
      const url = new URL(href, 'https://duckduckgo.com');
      if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.searchParams.has('uddg')) target = url.searchParams.get('uddg');
    } catch { continue; }
    if (/^https?:\/\//i.test(target)) urls.push(target);
  }
  return urls;
}

/** DuckDuckGo answers a suspected bot with a 202 or a page about an "anomaly" instead of results. */
export const isChallenge = (status, html) => status !== 200 || /anomaly-modal|anomaly\.js/i.test(String(html));

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the queries and returns the boards found. Stops at the first challenge
 * and keeps what was already found; never retries it.
 */
export async function searchBoards({ config = SEARCH_DEFAULTS, start = 0, fetch: fetchImpl = fetch, sleep = sleepFor, endpoint = SEARCH_ENDPOINT } = {}) {
  const every = buildQueries(config);
  const first = every.length ? start % every.length : 0;
  const queries = Array.from({ length: Math.min(config.max_queries, every.length) }, (_, index) => every[(first + index) % every.length]);
  const boards = new Set();
  const errors = [];
  let ran = 0;
  for (const query of queries) {
    if (ran > 0 && config.delay_seconds > 0) await sleep(config.delay_seconds * 1000);
    ran += 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let response; let html;
      try {
        response = await fetchImpl(`${endpoint}?q=${encodeURIComponent(query)}`, { headers: { accept: 'text/html', 'user-agent': USER_AGENT }, signal: controller.signal });
        html = await response.text();
      } finally { clearTimeout(timer); }
      if (isChallenge(response.status, html)) {
        errors.push({ source: 'search', error: `DuckDuckGo did not return results (status ${response.status}); stopped after ${ran - 1} of ${queries.length} queries and will not retry; the next run resumes here` });
        return { boards: [...boards].sort(), queries: ran, planned: queries.length, blocked: true, next: first + ran - 1, errors };
      }
      for (const url of parseResultUrls(html)) {
        const board = boardFromUrl(url);
        if (board) boards.add(board);
      }
    } catch (error) {
      errors.push({ source: query, error: String(error.message).slice(0, 200) });
    }
  }
  return { boards: [...boards].sort(), queries: ran, planned: queries.length, blocked: false, next: first + ran, errors };
}
