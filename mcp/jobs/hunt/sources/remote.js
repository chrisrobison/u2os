import { buildSighting, getJson, getText, plain, salaryRange } from './common.js';
import { decodeEntities } from '../jobs/text.js';

// Remote-job aggregators with public feeds meant for reuse.
//  - RemoteOK (https://remoteok.com/api). Its terms require crediting RemoteOK
//    and linking back to the listing; the credit is kept on every record.
//  - We Work Remotely RSS feeds.

export const REMOTEOK_API = 'https://remoteok.com/api';
export const REMOTEOK_CREDIT = 'Job listing from RemoteOK (https://remoteok.com)';
export const WWR_FEEDS = ['remote-programming-jobs', 'remote-devops-sysadmin-jobs', 'remote-full-stack-programming-jobs', 'remote-back-end-programming-jobs'];
const wwrUrl = (slug) => `https://weworkremotely.com/categories/${slug}.rss`;

export async function discoverRemoteOk({ fetch: fetchImpl = fetch, api = REMOTEOK_API } = {}) {
  const data = await getJson(fetchImpl, api);
  if (!Array.isArray(data)) throw new Error('remoteok: unexpected response');
  const sightings = data.filter((item) => item && item.position && item.company).map((item) => buildSighting({
    source: 'remoteok', sourceKey: `remoteok:${item.id}`, company: item.company, role: item.position,
    text: `${plain(item.description)}${(item.tags ?? []).length ? `\n\nTags: ${item.tags.join(', ')}` : ''}`,
    locations: [item.location || 'Remote'], remote: true,
    salary: Number(item.salary_min) > 0 ? salaryRange(item.salary_min, item.salary_max || item.salary_min, 'USD') : undefined,
    applicationUrl: item.apply_url || item.url, sourceUrl: item.url, postedAt: item.date || null,
    extra: { attribution: REMOTEOK_CREDIT },
  }));
  return { sightings, errors: [] };
}

const tag = (xml, name) => {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!match) return '';
  return decodeEntities(match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
};

export function parseRss(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => ({
    title: tag(match[1], 'title'), region: tag(match[1], 'region'), category: tag(match[1], 'category'),
    description: tag(match[1], 'description'), link: tag(match[1], 'link') || tag(match[1], 'guid'), published: tag(match[1], 'pubDate'),
  }));
}

export async function discoverWeWorkRemotely({ fetch: fetchImpl = fetch, feeds = WWR_FEEDS } = {}) {
  const sightings = [];
  const errors = [];
  const seen = new Set();
  for (const slug of feeds) {
    try {
      const xml = await getText(fetchImpl, wwrUrl(slug));
      for (const item of parseRss(xml ?? '')) {
        if (!item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        const split = item.title.match(/^(.+?):\s+(.+)$/);
        if (!split) continue;
        const published = Date.parse(item.published);
        sightings.push(buildSighting({
          source: 'weworkremotely', sourceKey: `wwr:${new URL(item.link).pathname.split('/').filter(Boolean).pop()}`, company: split[1], role: split[2],
          text: plain(item.description), locations: [item.region || 'Remote'], remote: true,
          applicationUrl: item.link, sourceUrl: item.link, postedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
        }));
      }
    } catch (error) { errors.push({ item: slug, error: String(error.message).slice(0, 200) }); }
  }
  return { sightings, errors };
}
