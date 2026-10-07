// `npm run u2 -- job <command>` (docs/job-hunt.md).
//
//   discover hn [--month "October 2026"] [--limit n] [--dry-run]
//   status [--json]
//
// The hunt store lives in the owner's vault (job-hunt/state/hunt.sqlite), not
// in U2OS_HOME, so these commands do not need the server stopped.
import { getVaultDir } from '../vault/vault-dir.js';
import { openStore, huntDbPath } from '../../mcp/jobs/hunt/storage/store.js';
import { discover } from '../../mcp/jobs/hunt/discover.js';

export const USAGE = `Usage: npm run u2 -- job <command>

  discover hn [--month "October 2026"] [--limit <n>] [--dry-run]
  status [--json]`;

function parseFlags(args, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (valueFlags.includes(name)) {
        const value = inline ?? args[(i += 1)];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        flags[name] = value;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

export async function main(argv, out = console, { vaultDir = getVaultDir(), fetch: fetchImpl = fetch, now = new Date() } = {}) {
  const [verb, ...rest] = argv;
  if (!verb || verb === 'help' || verb === '--help') { out.log(USAGE); return 0; }
  const store = openStore(huntDbPath(vaultDir));
  try {
    switch (verb) {
      case 'discover': {
        const { flags, positional } = parseFlags(rest, ['month', 'limit']);
        const summary = await discover({
          store, source: positional[0] || 'hn', fetch: fetchImpl, now, dryRun: flags['dry-run'] === true,
          month: flags.month ?? null, limit: flags.limit ? Number.parseInt(flags.limit, 10) : null,
        });
        out.log(`Thread: ${summary.thread.title} (item ${summary.thread.id})`);
        out.log(`${summary.comments} comments, ${summary.listings} job records parsed, ${summary.skipped.length} comments skipped`);
        out.log(summary.dryRun ? 'Dry run: nothing stored.' : `New: ${summary.created}  Merged into known jobs: ${summary.merged}  Already seen: ${summary.alreadyKnown}`);
        return 0;
      }
      case 'status': {
        const { flags } = parseFlags(rest);
        const counts = store.counts();
        if (flags.json) out.log(JSON.stringify({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }));
        else {
          const entries = Object.entries(counts);
          out.log(entries.length ? entries.map(([status, n]) => `${status.padEnd(20)} ${n}`).join('\n') : 'No jobs yet. Run: npm run u2 -- job discover hn');
        }
        return 0;
      }
      default:
        out.log(USAGE);
        return 1;
    }
  } finally {
    store.close();
  }
}
