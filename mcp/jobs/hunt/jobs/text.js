// HN comments arrive as a small HTML subset. Everything in them is untrusted
// DATA: this module only converts it to plain text and never interprets it.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#x2F': '/', '#x27': "'" };

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name in ENTITIES) return ENTITIES[name];
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Link targets found in the HTML, plus the text with markup removed. */
export function htmlToText(html) {
  const links = [];
  const withLinks = String(html ?? '').replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_whole, href, label) => {
    const url = decodeEntities(href);
    links.push(url);
    // Keep the visible label; HN truncates long URLs in it, so the href wins.
    return /^https?:/i.test(url) ? ` ${url} ` : label;
  });
  const text = decodeEntities(withLinks
    .replace(/<(p|br|li|div|pre|h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, links };
}
