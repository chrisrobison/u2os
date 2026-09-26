/** Shared, conservative URL identity for indexed and visible evidence. */
export function canonicalFindingUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (/(?:token|password|secret|authorization|api[_-]?key|credential)[^=&#]*=/i.test(decodeURIComponent(url.hash))) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|password|secret|authorization|api[_-]?key|credential)/i.test(key)) return null;
      if (/^utm_/i.test(key) || ['gclid', 'fbclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}
