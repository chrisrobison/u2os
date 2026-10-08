import { buildSighting, getJson, getText, mapLimit } from './common.js';
import { decodeEntities, htmlToText } from '../jobs/text.js';

// Hacker News's own jobs feed: openings at YC companies, posted by HN itself
// (https://news.ycombinator.com/jobs). Titles read like "Acme (YC W24) Is
// Hiring a Senior Engineer"; the item usually links to the posting.

export const HN_API = 'https://hacker-news.firebaseio.com/v0';

export function parseTitle(title) {
  const text = decodeEntities(String(title ?? '')).trim();
  const hiring = text.match(/^(.+?)\s+(?:is|are)\s+hiring\s*(?:[:\-–—]\s*)?(?:an?\s+|our\s+(?:first\s+)?|a\s+founding\s+)?(.*)$/i);
  if (hiring) return { company: hiring[1].trim(), role: hiring[2].replace(/^for\s+/i, '').replace(/\s+\(.*?remote.*?\)\s*$/i, '').trim() || null };
  const split = text.split(/\s+(?:[-–—|]|at)\s+/);
  if (split.length >= 2 && /engineer|developer|architect|manager|director|lead|cto|scientist/i.test(split[0])) return { company: split[1].replace(/\s*\|.*$/, '').trim(), role: split[0].trim() };
  return { company: text, role: null };
}

/** The title, description and visible text of a posting page, for listings whose title names no role. */
export function pageSummary(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const description = String(html).match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? '';
  const body = htmlToText(String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')).text;
  return { title: decodeEntities(title), description: decodeEntities(description), text: body.slice(0, 6000) };
}

function roleFromPageTitle(title) {
  const match = title.match(/^(.+?)\s+at\s+.+?(?:\s*[|\-–]\s*.*)?$/i);
  return match && match[1].length <= 120 ? match[1].trim() : null;
}

export async function discoverHnJobs({ fetch: fetchImpl = fetch, api = HN_API, limit = 60, readPages = true } = {}) {
  const ids = (await getJson(fetchImpl, `${api}/jobstories.json`)) ?? [];
  const { results, errors } = await mapLimit(ids.slice(0, limit), 6, async (id) => {
    const item = await getJson(fetchImpl, `${api}/item/${id}.json`);
    if (!item || item.type !== 'job' || item.dead || item.deleted) return null;
    const parsed = parseTitle(item.title);
    let text = item.text ? htmlToText(item.text).text : '';
    let { role } = parsed;
    if (readPages && item.url && /^https?:\/\//.test(item.url) && !text) {
      try {
        const html = await getText(fetchImpl, item.url, { timeoutMs: 12_000 });
        if (html) {
          const page = pageSummary(html);
          text = [page.title, page.description, page.text].filter(Boolean).join('\n\n');
          role ??= roleFromPageTitle(page.title);
        }
      } catch { /* the title alone is still a listing */ }
    }
    return buildSighting({
      source: 'hnjobs', sourceKey: `hnjob:${item.id}`, company: parsed.company, role,
      text: [decodeEntities(item.title), text].filter(Boolean).join('\n\n'), locations: [],
      applicationUrl: item.url ?? null, sourceUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      postedAt: item.time ? new Date(item.time * 1000).toISOString() : null, author: item.by ?? null,
    });
  });
  return { sightings: results.filter(Boolean), errors };
}
