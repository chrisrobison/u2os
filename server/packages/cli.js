// `npm run u2 -- <noun> <verb> ...` (docs/plugin-architecture.md §12).
// Offline, like the other *-cli.js commands: it refuses to run while the
// runtime owns this U2OS_HOME. Use the owner API (/api/packages,
// /api/automations) while the server is running.
import { withOfflineHome } from '../runtime/offline-home.js';
import { getDb, getDataDir } from '../db/connection.js';
import { EventBus } from '../events/event-bus.js';
import { PolicyEngine } from '../policy/policy-engine.js';
import { createToolRegistry } from '../tools/register-all.js';
import { Agent } from '../agent/agent.js';
import { createPackagePlatform } from './platform.js';
import { listPackageAudit } from './store.js';

const USAGE = `Usage: npm run u2 -- <command>

  package review <dir|archive|git+url>        Show what a package would install and ask for
  package install <dir|archive|git+url> [--grant-all]
  package uninstall <id> [--force]
  package list | show <id>
  package enable <id> | disable <id>
  package grant <id> <permission...|--all>
  package revoke <id> <permission...|--all>
  package config <id> [key=value...] [--policy name=automatic|required|never|default]
  package secret <id> <name> <value|--delete>

  capability list
  skill list

  automation list
  automation enable|disable|pause|resume|stop|inspect <id>
  automation run <id> [key=value...]
  automation run-detail <run-id>

  audit [--package <id>] [--automation <id>]`;

const VALUE_FLAGS = ['--policy', '--package', '--automation'];

export async function main(argv, out = console) {
  const [noun, verb, ...rest] = argv;
  if (!noun || noun === 'help' || noun === '--help') { out.log(USAGE); return 0; }
  // Boolean flags only; --policy, --package and --automation take a value.
  const flags = new Set(rest.filter((arg) => arg.startsWith('--') && !arg.includes('=') && !VALUE_FLAGS.includes(arg)));
  const args = rest.filter((arg) => !flags.has(arg));
  let code = 0;
  await withOfflineHome(async () => {
    const platform = createCliPlatform();
    try {
      code = await dispatch(platform, noun, verb, args, flags, out);
    } finally {
      await platform.runtime.stop();
    }
  });
  return code;
}

function createCliPlatform() {
  const eventBus = new EventBus(getDb());
  // No model is configured or needed: package workflows are deterministic,
  // and every capability call still goes through the agent's action gate.
  const agent = new Agent({ policyEngine: new PolicyEngine(), toolRegistry: createToolRegistry(), eventBus });
  return createPackagePlatform({ agent, eventBus, dataDir: getDataDir() });
}

async function dispatch({ manager, runtime }, noun, verb, args, flags, out) {
  const need = (count) => { if (args.length < count) throw usage(); };
  switch (`${noun} ${verb}`) {
    case 'package review': need(1); printReview(await manager.review(args[0]), out); return 0;
    case 'package install': {
      need(1);
      const review = await manager.review(args[0]);
      printReview(review, out);
      if (!review.installable) return 1;
      const installed = await manager.install(args[0], { grant: flags.has('--grant-all') ? 'all' : null, grantedBy: 'owner-cli' });
      out.log(`\nInstalled ${installed.id} ${installed.version}. Automations are disabled until you enable them.`);
      if (!flags.has('--grant-all') && installed.permissions.length) out.log(`No permissions granted yet: npm run u2 -- package grant ${installed.id} --all`);
      return 0;
    }
    case 'package uninstall': need(1); out.log(JSON.stringify(manager.uninstall(args[0], { force: flags.has('--force') }), null, 2)); return 0;
    case 'package list': printTable(manager.list().map((p) => [p.id, p.version, p.enabled ? 'enabled' : 'disabled', p.loaded ? '' : `not loaded: ${p.loadError}`, p.name]), out); return 0;
    case 'package show': need(1); out.log(JSON.stringify(manager.get(args[0]), null, 2)); return 0;
    case 'package enable': need(1); manager.setEnabled(args[0], true); out.log(`${args[0]} enabled`); return 0;
    case 'package disable': need(1); manager.setEnabled(args[0], false); out.log(`${args[0]} disabled`); return 0;
    case 'package grant': need(1); printPermissions(manager.grant(args[0], flags.has('--all') ? 'all' : args.slice(1), 'owner-cli'), out); return 0;
    case 'package revoke': need(1); printPermissions(manager.revoke(args[0], flags.has('--all') ? 'all' : args.slice(1)), out); return 0;
    case 'package config': {
      need(1);
      const settings = {};
      const policies = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--policy') { const [name, value] = splitPair(args[++i]); policies[name] = value === 'default' ? null : value; continue; }
        const [key, value] = splitPair(args[i]);
        settings[key] = value === 'null' ? null : parseValue(value);
      }
      const detail = manager.configure(args[0], { settings: Object.keys(settings).length ? settings : null, policies: Object.keys(policies).length ? policies : null });
      out.log(JSON.stringify({ settings: detail.settings.values, policies: detail.policies }, null, 2));
      return 0;
    }
    case 'package secret': need(2); out.log(JSON.stringify(manager.setSecret(args[0], args[1], flags.has('--delete') ? null : args[2] ?? ''), null, 2)); return 0;
    case 'capability list': printTable(manager.capabilities().map((c) => [c.id, c.version, c.effect, c.source, c.selectedProvider || '-', c.requiredPermissions.join(',')]), out); return 0;
    case 'skill list': printTable(manager.skills().map((s) => [s.id, s.version, s.packageId, s.dependencies.capabilities.join(','), s.dependencies.skills.join(',')]), out); return 0;
    case 'automation list': printTable(runtime.list().map((a) => [a.id, a.enabled ? (a.paused ? 'paused' : 'enabled') : 'disabled', a.running ? 'running' : 'idle', a.nextRunAt || '-', a.lastRun?.status || '-', a.packageId]), out); return 0;
    case 'automation enable': case 'automation disable': case 'automation pause': case 'automation resume':
      need(1); runtime[verb](args[0]); out.log(`${args[0]} ${{ enable: 'enabled', disable: 'disabled', pause: 'paused', resume: 'resumed' }[verb]}`); return 0;
    case 'automation stop': need(1); out.log(`Cancelled ${runtime.stopRuns(args[0]).length} run(s)`); return 0;
    case 'automation inspect': need(1); out.log(JSON.stringify(runtime.inspect(args[0]), null, 2)); return 0;
    case 'automation run': {
      need(1);
      const inputs = Object.fromEntries(args.slice(1).map((pair) => { const [key, value] = splitPair(pair); return [key, parseValue(value)]; }));
      const run = await runtime.runNow(args[0], inputs);
      out.log(JSON.stringify(runtime.runDetail(run.id), null, 2));
      return run.status === 'failed' ? 1 : 0;
    }
    case 'automation run-detail': need(1); out.log(JSON.stringify(runtime.runDetail(args[0]), null, 2)); return 0;
    default:
      if (noun === 'audit') {
        const option = (name) => { const index = [verb, ...args].indexOf(name); return index >= 0 ? [verb, ...args][index + 1] : null; };
        printTable(listPackageAudit({ packageId: option('--package'), automationId: option('--automation') }).map((entry) => [
          entry.createdAt, entry.context.package, entry.context.automation || entry.context.skill || '-', entry.action, entry.status, entry.context.policy ? `${entry.context.policy.name}:${entry.context.policy.decision}` : '-', entry.rule || '-',
        ]), out);
        return 0;
      }
      throw usage();
  }
}

export function printReview(review, out = console) {
  out.log(`${review.name} ${review.version} (${review.id})${review.upgradeFrom ? ` — upgrade from ${review.upgradeFrom}` : ''}`);
  if (review.description) out.log(review.description);
  out.log(`\n${review.name} wants permission to:`);
  if (!review.permissions.length) out.log('  (nothing)');
  for (const permission of review.permissions) out.log(`  ✓ ${permission.description}${permission.sensitive ? '  [sensitive]' : ''}`);
  if (review.policies.length) {
    out.log('\nAutomatic actions (package policies; your policies.yaml still applies):');
    for (const policy of review.policies) {
      out.log(`  ${policy.approval === 'automatic' ? '✓' : '✗'} ${policy.description || policy.name}${policy.approval === 'automatic' ? '' : policy.approval === 'never' ? ' (never)' : ' (asks you first)'}`);
    }
  }
  if (review.exports.automations.length) {
    out.log('\nAutomations (installed disabled):');
    for (const automation of review.exports.automations) out.log(`  - ${automation.id}: ${automation.triggers.map((t) => t.type).join(', ')}`);
  }
  if (review.secrets.length) out.log(`\nSecrets it will ask for: ${review.secrets.join(', ')}`);
  if (review.problems.length) out.log(`\nCannot install:\n  - ${review.problems.join('\n  - ')}`);
}

function printPermissions(detail, out) {
  for (const permission of detail.permissions) out.log(`${permission.granted ? '✓' : '·'} ${permission.permission}  ${permission.description}`);
}

function printTable(rows, out) {
  if (!rows.length) { out.log('(none)'); return; }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column] ?? '').length)));
  for (const row of rows) out.log(row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ').trimEnd());
}

function splitPair(text) {
  const index = String(text ?? '').indexOf('=');
  if (index < 1) throw usage();
  return [text.slice(0, index), text.slice(index + 1)];
}

function parseValue(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function usage() {
  const error = new Error(USAGE);
  error.usage = true;
  return error;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.usage ? error.message : `Error: ${error.message}`);
    process.exitCode = 1;
  });
}
