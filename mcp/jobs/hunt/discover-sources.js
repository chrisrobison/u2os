import { discover as discoverHackerNewsThread } from './discover.js';
import { fetchBoard, parseBoard } from './sources/ats.js';
import { discoverHnJobs } from './sources/hnjobs.js';
import { discoverRemoteOk, discoverWeWorkRemotely } from './sources/remote.js';
import { mapLimit } from './sources/common.js';
import { loadCursor, saveCursor, SEARCH_DEFAULTS, searchBoards } from './sources/search.js';
import { skipReason } from './jobs/relevance.js';

// Discovery from the sources beyond the monthly HN thread. Every source
// returns sightings in the store's shape; this stores them (deduplicated
// against everything already seen) after the relevance filter, and reports
// what was kept, skipped and why. One failing source or board never stops
// the others.

export const SOURCES = ['hn', 'hn-jobs', 'boards', 'remote', 'search'];

function ingest({ store, sightings, preferences, all, dryRun, now }) {
  const summary = { fetched: sightings.length, kept: 0, skipped: {}, created: 0, merged: 0, alreadyKnown: 0 };
  for (const sighting of sightings) {
    const reason = all ? null : skipReason(sighting, preferences);
    if (reason) { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; continue; }
    summary.kept += 1;
    if (dryRun) continue;
    const result = store.upsertSighting(sighting, now);
    if (result.duplicate) summary.alreadyKnown += 1;
    else if (result.created) summary.created += 1;
    else summary.merged += 1;
  }
  return summary;
}

export async function discoverBoards({ store, boards, preferences, all = false, dryRun = false, fetch: fetchImpl = fetch, now = new Date(), concurrency = 3 }) {
  const perBoard = [];
  const { errors } = await mapLimit(boards, concurrency, async (name) => {
    parseBoard(name);
    const sightings = await fetchBoard(name, { fetch: fetchImpl });
    perBoard.push({ board: name, ...ingest({ store, sightings, preferences, all, dryRun, now }) });
  });
  const total = (key) => perBoard.reduce((sum, entry) => sum + entry[key], 0);
  const skipped = {};
  for (const entry of perBoard) for (const [reason, n] of Object.entries(entry.skipped)) skipped[reason] = (skipped[reason] ?? 0) + n;
  return { source: 'boards', boards: boards.length, fetched: total('fetched'), kept: total('kept'), skipped, created: total('created'), merged: total('merged'), alreadyKnown: total('alreadyKnown'), perBoard: perBoard.sort((a, b) => b.kept - a.kept), errors: errors.map((e) => ({ source: e.item, error: e.error })), dryRun };
}

/**
 * Finds boards through search-engine queries, then reads the ones not already
 * known. Boards that are stored as listings are picked up by later board crawls
 * through their application links, so a found board stays in the rotation.
 */
export async function discoverSearch({ store, vaultDir = null, searches = SEARCH_DEFAULTS, known = [], preferences, all = false, dryRun = false, fetch: fetchImpl = fetch, sleep, now = new Date() }) {
  const found = await searchBoards({ config: searches, start: vaultDir ? loadCursor(vaultDir) : 0, fetch: fetchImpl, ...(sleep ? { sleep } : {}) });
  if (vaultDir && !dryRun) saveCursor(vaultDir, found.next);
  const knownSet = new Set(known);
  const fresh = found.boards.filter((board) => !knownSet.has(board)).slice(0, searches.max_boards);
  const crawl = fresh.length ? await discoverBoards({ store, boards: fresh, preferences, all, dryRun, fetch: fetchImpl, now }) : null;
  return {
    source: 'search', queries: found.queries, boardsFound: found.boards.length, newBoards: fresh, blocked: found.blocked,
    fetched: crawl?.fetched ?? 0, kept: crawl?.kept ?? 0, skipped: crawl?.skipped ?? {}, created: crawl?.created ?? 0, merged: crawl?.merged ?? 0, alreadyKnown: crawl?.alreadyKnown ?? 0,
    perBoard: crawl?.perBoard ?? [], errors: [...found.errors, ...(crawl?.errors ?? [])], dryRun,
  };
}

async function simple(source, run, { store, preferences, all, dryRun, now }) {
  const { sightings, errors } = await run();
  return { source, ...ingest({ store, sightings, preferences, all, dryRun, now }), errors: errors.map((e) => ({ source: e.item ?? source, error: e.error })), dryRun };
}

/**
 * Runs one source (or all of them). `options.boards` is the resolved board
 * list for the boards source. Returns an array of per-source summaries.
 */
export async function discoverSources({ store, source = 'all', preferences, boards = [], searches = SEARCH_DEFAULTS, vaultDir = null, sleep = null, all = false, dryRun = false, fetch: fetchImpl = fetch, now = new Date(), month = null, limit = null }) {
  const wanted = source === 'all' ? SOURCES : [source];
  const unknown = wanted.find((name) => !SOURCES.includes(name));
  if (unknown) throw new Error(`Unknown source "${unknown}" (supported: ${SOURCES.join(', ')}, all)`);
  const common = { store, preferences, all, dryRun, now };
  const summaries = [];
  for (const name of wanted) {
    try {
      if (name === 'hn') summaries.push({ ...(await discoverHackerNewsThread({ store, source: 'hn', fetch: fetchImpl, now, dryRun, month, limit })), source: 'hn' });
      else if (name === 'boards') summaries.push(await discoverBoards({ ...common, boards, fetch: fetchImpl }));
      else if (name === 'search') summaries.push(await discoverSearch({ ...common, vaultDir, searches, known: boards, fetch: fetchImpl, ...(sleep ? { sleep } : {}) }));
      else if (name === 'hn-jobs') summaries.push(await simple('hn-jobs', () => discoverHnJobs({ fetch: fetchImpl, ...(limit ? { limit } : {}) }), common));
      else if (name === 'remote') {
        const [ok, wwr] = await Promise.all([
          simple('remoteok', () => discoverRemoteOk({ fetch: fetchImpl }), common).catch((error) => ({ source: 'remoteok', fetched: 0, kept: 0, skipped: {}, created: 0, merged: 0, alreadyKnown: 0, errors: [{ source: 'remoteok', error: String(error.message).slice(0, 200) }] })),
          simple('weworkremotely', () => discoverWeWorkRemotely({ fetch: fetchImpl }), common).catch((error) => ({ source: 'weworkremotely', fetched: 0, kept: 0, skipped: {}, created: 0, merged: 0, alreadyKnown: 0, errors: [{ source: 'weworkremotely', error: String(error.message).slice(0, 200) }] })),
        ]);
        summaries.push(ok, wwr);
      }
    } catch (error) {
      summaries.push({ source: name, fetched: 0, kept: 0, skipped: {}, created: 0, merged: 0, alreadyKnown: 0, errors: [{ source: name, error: String(error.message).slice(0, 200) }] });
    }
  }
  return summaries;
}
