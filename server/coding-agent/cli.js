// `npm run u2 -- coding-agent <command>` (docs/coding-agents.md).
//
//   providers [--json]                 which coding agents are installed and usable
//   run [options] <task|->             run a task through a coding agent
//   runs [--status s] [--limit n]      recent runs
//   show <run-id>                      one run, as recorded
//
// Typing this command is the owner directing the work at their own terminal,
// so it calls the service directly. Anything acting without the owner typing
// (packages, routines) reaches a coding agent only through the gated
// `coding.agent` capability.
//
// Like the other offline CLIs, run/runs/show refuse to run while the U2OS
// server owns this U2OS_HOME. `providers` only inspects executables and
// needs no database.
import path from 'node:path';
import os from 'node:os';
import { withOfflineHome } from '../runtime/offline-home.js';
import { getDb } from '../db/connection.js';
import { EventBus } from '../events/event-bus.js';
import { createCodingAgentRegistry, createCodingAgentService } from './index.js';
import { FILESYSTEM_LEVELS } from './types.js';

const USAGE = `Usage: npm run u2 -- coding-agent <command>

  providers [--json]
  run --cwd <dir> [--provider auto|<id>] [--preference a,b] [--write | --filesystem ${FILESYSTEM_LEVELS.join('|')}]
      [--shell] [--git] [--network] [--timeout <seconds>] [--json] <task | ->
  runs [--status <status>] [--limit <n>]
  show <run-id>

Permissions default to read-only with no shell, git or network. "-" reads the task from stdin.
Exit status: 0 completed, 1 failed or error, 2 needs input, 130 cancelled.`;

const VALUE_FLAGS = new Set(['--provider', '--cwd', '--preference', '--filesystem', '--timeout', '--status', '--limit']);
const BOOLEAN_FLAGS = new Set(['--write', '--shell', '--git', '--network', '--json']);
const EXIT = { completed: 0, failed: 1, needs_input: 2, cancelled: 130 };

export async function main(argv, out = console, { stdin = process.stdin } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') { out.log(USAGE); return 0; }
  let parsed;
  try { parsed = parseArgs(rest); } catch (error) { out.error(`${error.message}\n\n${USAGE}`); return 1; }
  try {
    switch (command) {
      case 'providers': return await providers(parsed, out);
      case 'run': return await withOfflineHome(() => run(parsed, out, stdin));
      case 'runs': return await withOfflineHome(() => runs(parsed, out));
      case 'show': return await withOfflineHome(() => show(parsed, out));
      default: out.error(`Unknown command: ${command}\n\n${USAGE}`); return 1;
    }
  } catch (error) {
    out.error(`Error: ${error.message}`);
    return 1;
  }
}

async function providers({ flags }, out) {
  const found = await createCodingAgentRegistry().discover();
  if (flags['--json']) { out.log(JSON.stringify(found, null, 2)); return 0; }
  table([['PROVIDER', 'STATUS', 'DETAIL'], ...found.map((p) => [p.id, p.available ? 'available' : 'unavailable', p.available ? p.version || '' : p.reason || ''])], out);
  return found.some((p) => p.available) ? 0 : 1;
}

async function run({ flags, positional }, out, stdin) {
  if (!flags['--cwd']) throw new Error('--cwd is required: every run needs an explicit working directory');
  if (positional.length !== 1) throw new Error('Give the task as one argument (quote it), or "-" to read it from stdin');
  const task = positional[0] === '-' ? await readAll(stdin) : positional[0];
  const filesystem = flags['--filesystem'] || (flags['--write'] ? 'project' : undefined);
  if (flags['--write'] && flags['--filesystem'] && flags['--filesystem'] !== 'project') throw new Error('Use either --write or --filesystem, not both');
  const timeout = flags['--timeout'] === undefined ? undefined : Number(flags['--timeout']) * 1000;
  if (timeout !== undefined && !Number.isFinite(timeout)) throw new Error('--timeout takes a number of seconds');

  const service = createCodingAgentService({ eventBus: new EventBus(getDb()) });
  const json = flags['--json'];
  if (!json) {
    service.subscribe((event) => {
      if (event.type === 'coding.agent.started') out.error(`[${event.data.provider}] started in ${event.data.cwd}`);
      if (event.type === 'coding.agent.output') { if (event.data.stream === 'stderr') out.error(event.data.data); else out.log(event.data.data); }
    });
  }
  const handle = await service.start({
    task,
    cwd: path.resolve(expandHome(flags['--cwd'])),
    provider: flags['--provider'] || 'auto',
    preference: flags['--preference'] ? flags['--preference'].split(',').map((id) => id.trim()).filter(Boolean) : undefined,
    permissions: { ...(filesystem ? { filesystem } : {}), shell: flags['--shell'] || undefined, git: flags['--git'] || undefined, network: flags['--network'] || undefined },
    ...(timeout !== undefined ? { timeout } : {}),
  });
  const onSigint = () => { out.error('\nCancelling…'); handle.cancel(); };
  process.once('SIGINT', onSigint);
  let result;
  try { result = await handle.done; } finally { process.removeListener('SIGINT', onSigint); }

  if (json) { out.log(JSON.stringify(result, null, 2)); return EXIT[result.status] ?? 1; }
  out.error(`\n${result.status} — run ${result.id} (${result.provider}${result.exitCode !== undefined ? `, exit ${result.exitCode}` : ''})`);
  if (result.error) out.error(`error: ${result.error}`);
  if (result.filesChanged?.length) out.error(`files changed: ${result.filesChanged.join(', ')}`);
  out.error(`details: npm run u2 -- coding-agent show ${result.id}`);
  return EXIT[result.status] ?? 1;
}

function runs({ flags }, out) {
  const service = createCodingAgentService();
  const list = service.list({ status: flags['--status'] || null, limit: flags['--limit'] });
  table([['RUN', 'STATUS', 'PROVIDER', 'STARTED', 'DIRECTORY'], ...list.map((r) => [r.id, r.status, r.provider, r.startedAt, r.cwd])], out);
  return 0;
}

function show({ positional }, out) {
  if (positional.length !== 1) throw new Error('show takes a run id');
  const record = createCodingAgentService().get(positional[0]);
  if (!record) throw new Error(`No such run: ${positional[0]}`);
  out.log(JSON.stringify(record, null, 2));
  return 0;
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-') { positional.push(arg); continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
      flags[name] = value;
    } else throw new Error(`Unknown option: ${name}`);
  }
  return { flags, positional };
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

async function readAll(stream) {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

function table(rows, out) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column] ?? '').length)));
  for (const row of rows) out.log(row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ').trimEnd());
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
