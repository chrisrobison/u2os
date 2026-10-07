// Canonical forms used to recognise the same opportunity arriving through
// different sources (HN, Greenhouse, a careers page). Pure functions.

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc|pbc|labs?)\b\.?/g;

export function normalizeCompany(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[''`]/g, '')
    .replace(/&/g, ' and ')
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ROLE_REPLACEMENTS = [
  [/\bsr\.?(?=\s)/g, 'senior'],
  [/\bjr\.?(?=\s)/g, 'junior'],
  [/\bswe\b/g, 'software engineer'],
  [/\bsde\b/g, 'software engineer'],
  [/\beng(?:ineering)?\s+mgr\b/g, 'engineering manager'],
  [/\bfull[\s-]?stack\b/g, 'fullstack'],
  [/\bfront[\s-]?end\b/g, 'frontend'],
  [/\bback[\s-]?end\b/g, 'backend'],
  [/\bdevrel\b/g, 'developer relations'],
  [/\bvp\b/g, 'vice president'],
  [/\bengineers\b/g, 'engineer'],
  [/\bdevelopers?\b/g, 'engineer'],
];

export function normalizeRole(title) {
  let role = String(title ?? '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.\s]+/g, ' ');
  for (const [pattern, replacement] of ROLE_REPLACEMENTS) role = role.replace(pattern, replacement);
  return role.replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

const TRACKING_PARAMS = /^(utm_|gh_src|gh_jid_src|ref$|referrer|source$|src$|lever-source|lever-origin|fbclid|gclid|mc_)/i;

/** Lower-cased host, no www/fragment/tracking parameters/trailing slash. */
export function canonicalUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.replace(/\/+$/, '') || '';
  const query = url.searchParams.toString();
  return `${host}${pathname}${query ? `?${query}` : ''}`;
}

/** An applicant-tracking-system job id, which survives different URL shapes. */
export function atsJobId(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const jid = url.searchParams.get('gh_jid');
    const at = parts.indexOf('jobs');
    const id = at >= 0 ? parts[at + 1] : jid;
    const board = parts[0] && parts[0] !== 'embed' ? parts[0] : null;
    return id && /^\d+$/.test(id) ? `greenhouse:${(board || 'embed').toLowerCase()}:${id}` : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return parts[0] && parts[1] ? `lever:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}` : null;
  }
  if (host === 'jobs.ashbyhq.com') return parts[0] && parts[1] ? `ashby:${parts[0].toLowerCase()}:${parts[1].toLowerCase()}` : null;
  if (/(^|\.)workable\.com$/.test(host)) {
    const at = parts.indexOf('j');
    return at >= 0 && parts[at + 1] ? `workable:${parts[at + 1].toLowerCase()}` : null;
  }
  return null;
}

/** Every identity a job can be recognised by, strongest first. */
export function identityKeys({ company, role, applicationUrls = [], sourceKey }) {
  const keys = [];
  if (sourceKey) keys.push(`src:${sourceKey}`);
  for (const url of applicationUrls) {
    const ats = atsJobId(url);
    if (ats) keys.push(`ats:${ats}`);
    const canonical = canonicalUrl(url);
    if (canonical && canonical.includes('/')) keys.push(`url:${canonical}`);
  }
  const companyKey = normalizeCompany(company);
  const roleKey = normalizeRole(role);
  if (companyKey && roleKey) keys.push(`role:${companyKey}|${roleKey}`);
  return [...new Set(keys)];
}
