import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { JOB_HUNT_DIR } from '../../profile.js';

// job-hunt/autopilot.yaml: how the autonomous job hunter behaves. Everything
// has a safe default, and the default mode never sends or submits anything.
//
//   enabled: false                 # the loop runs only when true
//   mode: dry_run                  # dry_run: do everything except send/submit. live: act.
//   interval_seconds: 300          # how often a cycle runs
//   limits:
//     applications_per_day: 8      # form submissions in any 24 hours
//     emails_per_day: 10
//     per_company_days: 30         # no second application to the same company for this long
//   sources: [hn, hn-jobs, remote, boards]
//   boards_every_minutes: 60       # boards are large; read them less often
//   mail_sender: ""                # Mail account to send from, as Mail shows it; empty = Mail's default
//   allow:
//     relocation: false            # jobs flagged relocation_required
//     below_salary_minimum: false
//     equity_only: false           # postings that are unpaid until funded
//   browser:
//     headed: false                # open a visible browser window for form submits
//   routes:
//     email: true
//     form: false                  # off until a form submit has been shown to land (docs/job-hunt.md)
//   blocklist:
//     companies: []
//     domains: []
//     keywords: []

export const autopilotPath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'autopilot.yaml');

export const DEFAULTS = Object.freeze({
  enabled: false, mode: 'dry_run', interval_seconds: 300,
  limits: { applications_per_day: 8, emails_per_day: 10, per_company_days: 30 },
  sources: ['hn', 'hn-jobs', 'remote', 'boards'], boards_every_minutes: 60,
  allow: { relocation: false, below_salary_minimum: false, equity_only: false },
  blocklist: { companies: [], domains: [], keywords: [] },
  per_cycle: { score: 6, score_fast: 6, confirm: 2, prepare: 3, act: 3 }, mail_sender: '', routes: { email: true, form: false }, browser: { headed: false },
});

const int = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`autopilot.yaml: ${name} must be a whole number from ${min} to ${max}`);
  return value;
};
const list = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length > 200)) throw new Error(`autopilot.yaml: ${name} must be a list of short strings`);
  return value.map((item) => item.toLowerCase().trim()).filter(Boolean);
};

export function loadAutopilotConfig(vaultDir) {
  let data = {};
  try {
    const stat = fs.lstatSync(autopilotPath(vaultDir));
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('autopilot.yaml must be a regular file under 64 KiB');
    data = yaml.load(fs.readFileSync(autopilotPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('autopilot.yaml must be a mapping');
  if (data.mode !== undefined && !['dry_run', 'live'].includes(data.mode)) throw new Error('autopilot.yaml: mode must be dry_run or live');
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw new Error('autopilot.yaml: enabled must be true or false');
  const limits = { ...DEFAULTS.limits };
  for (const [key, [min, max]] of Object.entries({ applications_per_day: [0, 100], emails_per_day: [0, 200], per_company_days: [0, 365] })) if (data.limits?.[key] !== undefined) limits[key] = int(data.limits[key], `limits.${key}`, min, max);
  const sources = data.sources === undefined ? [...DEFAULTS.sources] : data.sources;
  if (!Array.isArray(sources) || sources.some((name) => !DEFAULTS.sources.includes(name))) throw new Error(`autopilot.yaml: sources must be a list of ${DEFAULTS.sources.join(', ')}`);
  const allow = { ...DEFAULTS.allow };
  for (const key of Object.keys(allow)) if (data.allow?.[key] !== undefined) { if (typeof data.allow[key] !== 'boolean') throw new Error(`autopilot.yaml: allow.${key} must be true or false`); allow[key] = data.allow[key]; }
  const per_cycle = { ...DEFAULTS.per_cycle };
  for (const key of Object.keys(per_cycle)) if (data.per_cycle?.[key] !== undefined) per_cycle[key] = int(data.per_cycle[key], `per_cycle.${key}`, 0, 50);
  return {
    enabled: data.enabled ?? DEFAULTS.enabled, mode: data.mode ?? DEFAULTS.mode,
    interval_seconds: data.interval_seconds === undefined ? DEFAULTS.interval_seconds : int(data.interval_seconds, 'interval_seconds', 60, 86_400),
    limits, sources, boards_every_minutes: data.boards_every_minutes === undefined ? DEFAULTS.boards_every_minutes : int(data.boards_every_minutes, 'boards_every_minutes', 5, 10_080),
    mail_sender: typeof data.mail_sender === 'string' && !/[\r\n\0]/.test(data.mail_sender) && data.mail_sender.length <= 200 ? data.mail_sender : '',
    routes: (() => { const routes = { ...DEFAULTS.routes }; for (const key of Object.keys(routes)) if (data.routes?.[key] !== undefined) { if (typeof data.routes[key] !== 'boolean') throw new Error(`autopilot.yaml: routes.${key} must be true or false`); routes[key] = data.routes[key]; } return routes; })(),
    browser: { headed: data.browser?.headed === undefined ? DEFAULTS.browser.headed : (typeof data.browser.headed === 'boolean' ? data.browser.headed : (() => { throw new Error('autopilot.yaml: browser.headed must be true or false'); })()) },
    allow, per_cycle, blocklist: { companies: list(data.blocklist?.companies, 'blocklist.companies'), domains: list(data.blocklist?.domains, 'blocklist.domains'), keywords: list(data.blocklist?.keywords, 'blocklist.keywords') },
  };
}

/**
 * Sets `enabled` and/or `mode` in autopilot.yaml, keeping every other key.
 * (Comments in the file are not preserved.) Only these two keys can be set
 * this way: limits and allowances are edited in the file by the owner.
 */
export function setAutopilotSwitches(vaultDir, { enabled, mode }) {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  if (mode !== undefined && !['dry_run', 'live'].includes(mode)) throw new Error('mode must be dry_run or live');
  let data = {};
  try { data = yaml.load(fs.readFileSync(autopilotPath(vaultDir), 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  if (enabled !== undefined) data.enabled = enabled;
  if (mode !== undefined) data.mode = mode;
  fs.mkdirSync(path.dirname(autopilotPath(vaultDir)), { recursive: true });
  fs.writeFileSync(autopilotPath(vaultDir), `# Autopilot settings (docs/job-hunt.md). Edit freely; the app only ever changes enabled and mode.\n${yaml.dump(data, { lineWidth: 120 })}`, { mode: 0o600 });
  return loadAutopilotConfig(vaultDir);
}
