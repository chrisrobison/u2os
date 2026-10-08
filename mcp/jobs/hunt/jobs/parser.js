import { htmlToText } from './text.js';

// Turns one Hacker News "Who is hiring?" comment into structured job records.
// Deterministic by design: the text is untrusted DATA from the open internet,
// so nothing here executes, follows or obeys it. (Model-assisted judgement
// happens later, on the structured record, never on instructions in the text.)

const ROLE_WORDS = /\b(engineer|engineers|developer|developers|programmer|architect|manager|director|designer|scientist|analyst|researcher|devops|sre|cto|cpo|ciso|vp|head of|lead|founder|founding|principal|staff|intern|specialist|consultant|administrator|recruiter|writer|evangelist|advocate|technician|swe|sdet|qa)\b/i;
const EMPLOYMENT = /^(full[\s-]?time|part[\s-]?time|contract(or)?|internship|permanent|freelance|fte|w2|c2c)$/i;
const PLACE_HINT = /\b(remote|hybrid|on[\s-]?site|onsite|worldwide|global|anywhere|us|usa|u\.s\.|united states|canada|uk|u\.k\.|europe|eu|emea|apac|latam|germany|berlin|london|paris|amsterdam|dublin|toronto|vancouver|montreal|sf|san francisco|bay area|nyc|new york|brooklyn|la|los angeles|seattle|portland|austin|boston|chicago|denver|boulder|atlanta|miami|san diego|san jose|palo alto|mountain view|sunnyvale|oakland|remote-first|tel aviv|singapore|sydney|melbourne|bangalore|zurich|stockholm|copenhagen|lisbon|madrid|barcelona|warsaw|prague|cambridge|pittsburgh|raleigh|dc|washington)\b/i;
const STATE = /,\s*[A-Z]{2}\b/;

export const TECH = ['JavaScript', 'TypeScript', 'Node.js', 'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Python', 'Django', 'Flask', 'FastAPI', 'Ruby', 'Rails', 'Go', 'Golang', 'Rust', 'Java', 'Kotlin', 'Scala', 'Clojure', 'Elixir', 'Erlang', 'Haskell', 'OCaml', 'C++', 'C#', '.NET', 'PHP', 'Laravel', 'Swift', 'iOS', 'Android', 'React Native', 'Flutter', 'PostgreSQL', 'Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Kafka', 'Elasticsearch', 'ClickHouse', 'Snowflake', 'AWS', 'GCP', 'Azure', 'Kubernetes', 'Docker', 'Terraform', 'GraphQL', 'gRPC', 'WebRTC', 'WebAssembly', 'LLM', 'LLMs', 'PyTorch', 'TensorFlow', 'Machine Learning', 'ML', 'AI', 'MCP', 'Spark', 'Airflow', 'dbt', 'Linux', 'Embedded', 'FPGA', 'CUDA', 'Unity', 'Unreal', 'Zig', 'Lua', 'Perl', 'SQL', 'REST'];
const TECH_PATTERNS = TECH.map((name) => ({ name, pattern: new RegExp(`(?<![A-Za-z0-9+#.])${name.replace(/[.+#]/g, '\\$&')}(?![A-Za-z0-9+#])`, name.length <= 3 ? '' : 'i') }));

const ATS_HOST = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com|jobvite\.com|bamboohr\.com|workday|myworkdayjobs\.com|applytojob\.com|teamtailor\.com|rippling\.com\/.*jobs|dover\.com|wellfound\.com|angel\.co|ycombinator\.com\/companies\/.*\/jobs|notion\.site|comeet\.com|personio\.)/i;
const NOT_COMPANY_SITE = /(news\.ycombinator\.com|linkedin\.com|twitter\.com|x\.com|github\.com|facebook\.com|youtube\.com|crunchbase\.com|glassdoor\.com|indeed\.com|docs\.google\.com|forms\.gle|calendly\.com|bit\.ly|t\.co)/i;
const APPLY_PATH = /(\/apply|\/jobs?\b|\/careers?\b|\/positions?\b|\/openings?\b|\/join|\/hiring|\/work-with-us|\/opportunities)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const OBFUSCATED_EMAIL = /\b([A-Z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+)\s*([A-Z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.|\s+dot\s+)\s*[A-Z0-9-]+)*)\b/gi;

const clean = (value) => String(value).replace(/\s+/g, ' ').trim();
const unique = (items) => [...new Set(items)];

// Real top-level domains seen in job listings. An obfuscated address ("name at example dot com") is only
// believed when it ends in one of these: ordinary prose such as "be at home. We" must not become an address.
const OBFUSCATED_TLDS = new Set(['com', 'io', 'ai', 'co', 'org', 'net', 'dev', 'app', 'tech', 'xyz', 'so', 'cloud', 'edu', 'gov', 'me', 'us', 'uk', 'de', 'fr', 'nl', 'ca', 'eu', 'se', 'ch', 'jobs', 'careers', 'works', 'team', 'health', 'bio', 'sh', 'gg', 'inc', 'ly', 'fm', 'tv', 'example', 'test']);
const FREE_PREFIX = /^(?:be|we|you|me|us|it|is|at|in|on|to|of|and|or|the|a|an|looking|based|located|remote|onsite|hybrid|email|mail|send|contact|reach|apply|join)$/i;

export function extractEmails(text) {
  const found = [];
  for (const match of text.matchAll(EMAIL)) found.push(match[0]);
  for (const match of text.matchAll(OBFUSCATED_EMAIL)) {
    const domain = match[2].replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '');
    const tld = domain.split('.').pop().toLowerCase();
    const explicit = /\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}/i.test(match[0]);
    // Bracketed forms ([at], (at)) are deliberate obfuscation. A bare " at " is far more likely to be prose,
    // so it must also use a spelled-out "dot" or a plausible mailbox name.
    const deliberate = explicit || /\bdot\b/i.test(match[2]) || /[._+-]/.test(match[1]);
    if (OBFUSCATED_TLDS.has(tld) && domain.includes('.') && deliberate && match[1].length > 1 && !FREE_PREFIX.test(match[1])) found.push(`${match[1]}@${domain}`);
  }
  return unique(found.map((email) => email.replace(/[.,;:)]+$/, '').toLowerCase()).filter((email) => !/\.(png|jpe?g|gif|svg)$/.test(email) && OBFUSCATED_OK(email)));
}

// A plain (non-obfuscated) address must also have a plausible final label (letters only, 2-24 characters).
const OBFUSCATED_OK = (email) => /\.[a-z]{2,24}$/.test(email);

export function extractUrls(text, links = []) {
  const found = [...links.filter((link) => /^https?:/i.test(link))];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) found.push(match[0]);
  // Bare "company.com/careers" mentions.
  for (const match of text.matchAll(/(?<![@\w/.-])((?:[a-z0-9-]+\.)+(?:com|io|ai|co|dev|app|org|net|so|xyz|tech|cloud)(?:\/[^\s<>"')\]]*)?)/gi)) {
    if (!/@/.test(match[0]) && !found.some((url) => url.includes(match[1]))) found.push(`https://${match[1]}`);
  }
  return unique(found.map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => {
    try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
  }));
}

export function classifyUrls(urls, company) {
  const slug = String(company ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const applicationUrls = [];
  const others = [];
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (NOT_COMPANY_SITE.test(parsed.hostname)) continue;
    if (ATS_HOST.test(url) || (APPLY_PATH.test(parsed.pathname) && parsed.pathname.length > 1)) applicationUrls.push(url);
    else others.push(url);
  }
  const homepage = (url) => { const u = new URL(url); return `${u.protocol}//${u.hostname}`; };
  let companyUrl = null;
  const named = slug.length > 2 ? others.find((url) => new URL(url).hostname.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(slug)) : null;
  companyUrl = named ? homepage(named) : others[0] ? homepage(others[0]) : null;
  if (!companyUrl) {
    const site = applicationUrls.find((url) => !ATS_HOST.test(url) && new URL(url).hostname.toLowerCase().includes(slug) && slug.length > 2);
    if (site) companyUrl = homepage(site);
  }
  return { applicationUrls: unique(applicationUrls), companyUrl };
}

export function extractSalary(text) {
  const money = /(?<cur>[$€£])\s?(?<a>\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s?(?<ak>[kK])?\s*(?:-|–|—|to)\s*(?:[$€£]\s?)?(?<b>\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s?(?<bk>[kK])?/;
  const match = text.match(money);
  if (!match) return null;
  const { cur, a, ak, b, bk } = match.groups;
  const amount = (value, k) => { const n = Number(value.replace(/,/g, '')); return k || (n < 1000 && !/hour|\/hr/i.test(match[0])) ? n * 1000 : n; };
  const min = amount(a, ak || bk && Number(a) < 1000);
  const max = amount(b, bk || ak);
  if (!(min > 0 && max >= min) || max < 10_000) return null;
  return { min, max, currency: { $: 'USD', '€': 'EUR', '£': 'GBP' }[cur], raw: clean(match[0]) };
}

export function extractEquity(text) {
  const match = text.match(/[^.\n]*\b(equity|stock options?|esop|rsus?)\b[^.\n]*/i);
  return match ? clean(match[0]).slice(0, 200) : null;
}

export function extractVisa(text) {
  const negative = /\b(no visa|not (?:able to )?sponsor|unable to sponsor|cannot sponsor|can't sponsor|without sponsorship|no sponsorship|us work authorization required|must be authorized)\b/i;
  if (negative.test(text)) return 'no';
  if (/\b(visa|sponsorship|h-?1b|relocation)\b/i.test(text)) return /\b(visa|sponsor\w*|h-?1b)\b/i.test(text) ? 'yes' : 'mentioned';
  return null;
}

export function extractRemote(text, header = '') {
  const all = `${header}\n${text}`;
  if (/\b(no remote|not remote|onsite only|on-site only|in[\s-]office only|remote (?:is )?not)/i.test(all)) return false;
  if (/\bremote\b/i.test(all)) return true;
  if (/\b(on[\s-]?site|onsite|in[\s-]person|in[\s-]office)\b/i.test(header)) return false;
  return null;
}

export function extractTechnologies(text) {
  return TECH_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name).slice(0, 30);
}

function splitHeader(line) {
  const parts = line.split(/\s*\|\s*/).map(clean).filter(Boolean);
  if (parts.length >= 2) return parts;
  const dashes = line.split(/\s+[-–—]\s+/).map(clean).filter(Boolean);
  return dashes.length >= 2 ? dashes : [clean(line)];
}

function looksLikeRole(segment) {
  return segment.length <= 120 && ROLE_WORDS.test(segment) && !/^https?:/i.test(segment) && !/\b(is|are) (hiring|looking)\b/i.test(segment);
}

function splitRoles(segment) {
  const stripped = segment.replace(/^(hiring|seeking|looking for|roles?|positions?|open roles?)\s*[:\-]\s*/i, '');
  const pieces = stripped.split(/\s*(?:\/|;|\s&\s|\s+and\s+)\s*/).map(clean).filter(Boolean);
  const roles = [];
  let previous = '';
  for (const piece of pieces) {
    if (looksLikeRole(piece)) {
      // "Staff Engineer, Platform" is one role with a team; "Backend Engineer, Frontend Engineer" is two.
      const commas = piece.split(/,\s+(?=[A-Z])/).map(clean).filter(Boolean);
      if (commas.length > 1 && commas.every(looksLikeRole)) roles.push(...commas); else roles.push(piece);
      previous = piece;
      continue;
    }
    // "Backend / Frontend Engineer": a bare qualifier borrows the noun.
    const noun = previous.match(/\b(engineer|developer|designer|manager|scientist|architect)s?\b/i);
    if (noun && piece.split(' ').length <= 3 && /^[A-Za-z+#.\- ]+$/.test(piece)) roles.push(`${piece} ${noun[0]}`);
  }
  return roles.length ? roles : looksLikeRole(stripped) ? [stripped] : [];
}

function bulletRoles(lines) {
  const roles = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*•·▪◦]|\d+[.)])\s+(.{3,90})$/);
    if (!match) continue;
    const title = clean(match[1].replace(/\s*[(:–—-]\s.*$/, ''));
    if (looksLikeRole(title) && title.split(' ').length <= 8) roles.push(title);
  }
  return roles;
}

function cleanCompany(raw) {
  return clean(raw
    .replace(/\s+is\s+(hiring|looking).*$/i, '')
    .replace(/^[-–—*#\s]+/, ''))
    .slice(0, 120);
}

/**
 * Parse one comment. Returns { jobs, skipped } where jobs have one entry per
 * role (a comment listing three roles yields three records sharing the same
 * company, source comment and description).
 */
export function parseComment(comment, { threadId = null, now = new Date() } = {}) {
  const id = String(comment?.id ?? comment?.objectID ?? '');
  if (!id) return { jobs: [], skipped: 'no-id' };
  if (comment.deleted || comment.dead || comment.text == null || comment.text === '') return { jobs: [], skipped: 'empty' };
  const { text, links } = htmlToText(comment.text);
  if (text.length < 25) return { jobs: [], skipped: 'too-short' };

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const headerLine = lines[0];
  const headerParts = splitHeader(headerLine);
  const pipeStyle = headerParts.length >= 2;

  const company = cleanCompany(headerParts[0]);
  const roles = [];
  const locations = [];
  if (pipeStyle) {
    for (const part of headerParts.slice(1)) {
      if (looksLikeRole(part)) roles.push(...splitRoles(part));
      else if (EMPLOYMENT.test(part)) continue;
      else if (/^https?:/i.test(part) || /\$\s?\d/.test(part)) continue;
      else if (part.length <= 60 && (PLACE_HINT.test(part) || STATE.test(part))) locations.push(part);
    }
  }
  const bullets = bulletRoles(lines.slice(1));
  const rolesFound = unique([...roles, ...bullets].map(clean)).slice(0, 12);

  // Roles mentioned in a "we're hiring X" first sentence, no pipes.
  if (!rolesFound.length) {
    const hiring = text.match(/\b(?:hiring|looking for|seeking)\s+(?:an?\s+|our first\s+|a\s+founding\s+)?([A-Za-z0-9+/ -]{3,60}?(?:engineer|developer|designer|manager|architect|scientist|cto|lead)s?)\b/i);
    if (hiring) rolesFound.push(clean(hiring[1]));
  }

  const looksLikeListing = rolesFound.length > 0 || pipeStyle || /\b(hiring|apply|send (?:your )?(?:resume|cv)|email (?:us|me)|careers?|jobs?)\b/i.test(text);
  if (!looksLikeListing || !company) return { jobs: [], skipped: 'not-a-listing' };

  const emails = extractEmails(text);
  const urls = extractUrls(text, links);
  const { applicationUrls, companyUrl } = classifyUrls(urls, company);
  const description = lines.slice(pipeStyle ? 1 : 0).join('\n').trim() || text;
  const common = {
    source: 'hackernews',
    sourceThread: threadId ? String(threadId) : null,
    sourceComment: id,
    author: comment.author ?? null,
    company,
    locations: unique(locations).slice(0, 8),
    remote: extractRemote(text, headerLine),
    salary: extractSalary(text),
    equity: extractEquity(text),
    visa: extractVisa(text),
    technologies: extractTechnologies(text),
    description,
    contactEmails: emails,
    applicationUrls,
    companyUrl,
    rawText: text,
    sourceUrl: `https://news.ycombinator.com/item?id=${id}`,
    postedAt: comment.created_at || (comment.created_at_i ? new Date(comment.created_at_i * 1000).toISOString() : null),
    discoveredAt: now.toISOString(),
    parseQuality: pipeStyle && rolesFound.length ? 'high' : rolesFound.length ? 'medium' : 'low',
  };
  const list = rolesFound.length ? rolesFound : [null];
  return {
    jobs: list.map((role, index) => ({ ...common, role, roles: rolesFound, roleIndex: index, sourceKey: `hackernews:${id}#${index}` })),
    skipped: null,
  };
}
