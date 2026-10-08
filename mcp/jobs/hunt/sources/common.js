import { classifyUrls, extractEmails, extractEquity, extractRemote, extractSalary, extractTechnologies, extractUrls, extractVisa } from '../jobs/parser.js';
import { decodeEntities, htmlToText } from '../jobs/text.js';

// Shared by every discovery source: polite, bounded HTTP, and one builder for
// the normalized "sighting" the store takes. All fetched text is untrusted data.

// Sources whose text is written to invite contact. Board descriptions are not: their addresses are boilerplate.
export const CONTACT_SOURCES = new Set(['hackernews', 'hnjobs', 'remoteok', 'weworkremotely']);

export const USER_AGENT = 'u2os-job-hunter (+https://github.com/chrisrobison/u2os)';
const MAX_BYTES = 40 * 1024 * 1024; // a large Lever board with full descriptions is tens of MB

async function request(fetchImpl, url, { accept, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept, 'user-agent': USER_AGENT }, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error(`${new URL(url).host} returned too much data`);
    return text;
  } finally { clearTimeout(timer); }
}

export async function getJson(fetchImpl, url, options = {}) {
  const text = await request(fetchImpl, url, { accept: 'application/json', ...options });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { throw new Error(`${new URL(url).host} did not return JSON`); }
}

export const getText = (fetchImpl, url, options = {}) => request(fetchImpl, url, { accept: 'text/html,application/xml,text/xml,*/*', ...options });

/** HTML (possibly entity-escaped HTML, as Greenhouse sends) to plain text. */
export function plain(html) {
  const text = String(html ?? '');
  return htmlToText(/&lt;\w+/.test(text) && !/<\w+/.test(text) ? decodeEntities(text) : text).text;
}

const unique = (items) => [...new Set(items.filter(Boolean))];

/**
 * Builds a sighting from what a source knows. Fields the source did not
 * supply are extracted from the text with the same deterministic extractors
 * the HN parser uses.
 */
export function buildSighting({ source, sourceKey, company, role, text, locations = [], remote, salary, applicationUrl, companyUrl = null, sourceUrl = null, postedAt = null, author = null, sourceThread = null, contactEmails: givenContacts = null, extra = {} }) {
  const body = String(text ?? '').trim();
  const urls = extractUrls(body);
  const classified = classifyUrls(urls, company);
  const applicationUrls = unique([applicationUrl, ...classified.applicationUrls]).filter((url) => /^https?:\/\//i.test(url));
  const headline = [role, ...locations].filter(Boolean).join(' | ');
  return {
    source, sourceThread, sourceComment: null, sourceKey, author,
    company: String(company ?? '').trim().slice(0, 120), role: role ? String(role).trim().slice(0, 160) : null, roles: role ? [role] : [], roleIndex: 0,
    locations: unique(locations.map((location) => String(location).trim().slice(0, 80))).slice(0, 8),
    remote: remote ?? extractRemote(body, headline),
    salary: salary ?? extractSalary(body), equity: extractEquity(body), visa: extractVisa(body),
    technologies: extractTechnologies(`${role ?? ''}\n${body}`),
    description: body.slice(0, 20_000), contactEmails: givenContacts ?? extractEmails(body),
    applicationUrls, companyUrl: companyUrl ?? classified.companyUrl,
    rawText: body.slice(0, 40_000), sourceUrl, postedAt, discoveredAt: new Date().toISOString(), parseQuality: 'high',
    ...extra,
  };
}

/** Salary object from min/max numbers, or null. */
export function salaryRange(min, max, currency = 'USD') {
  const low = Number(min); const high = Number(max);
  if (!(low > 0 && high >= low) || high < 10_000) return null;
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] ?? `${currency} `;
  const short = (n) => (n % 1000 === 0 ? `${n / 1000}k` : String(n));
  return { min: low, max: high, currency, raw: `${symbol}${short(low)} - ${symbol}${short(high)}` };
}

/** Runs `fn` over items with bounded concurrency; errors are collected, never thrown. */
export async function mapLimit(items, limit, fn) {
  const results = [];
  const errors = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { results.push(await fn(item)); } catch (error) { errors.push({ item, error: String(error.message).slice(0, 200) }); }
    }
  }));
  return { results, errors };
}
