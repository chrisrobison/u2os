import { discoverHackerNews } from './sources/hackernews.js';

/** Discovers listings from one source and persists them. Returns a summary. */
export async function discover({ store, source = 'hn', now = new Date(), dryRun = false, ...options }) {
  if (!['hn', 'hackernews'].includes(source)) throw new Error(`Unknown source "${source}" (supported: hn)`);
  const found = await discoverHackerNews({ ...options, now });
  const summary = { source: 'hackernews', thread: found.thread, comments: found.comments, listings: found.jobs.length, created: 0, merged: 0, alreadyKnown: 0, skipped: found.skipped, dryRun };
  if (dryRun) return summary;
  for (const sighting of found.jobs) {
    const result = store.upsertSighting(sighting, now);
    if (result.duplicate) summary.alreadyKnown += 1;
    else if (result.created) summary.created += 1;
    else summary.merged += 1;
  }
  return summary;
}
