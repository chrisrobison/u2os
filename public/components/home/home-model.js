// Pure helpers for the Home overview (#495). Nothing here reads the DOM or the
// network: each function turns an existing API payload into what a panel shows,
// and says "unknown" rather than inventing a value when the payload lacks it.

export const JOURNAL_LIMIT = 500; // the most the journal endpoint returns
export const RECORD_LIMIT = 500; // the most /api/vault/records returns
const MAX_TIMELINE = 8;
const MAX_ROUTINES = 6;
const MAX_REASON = 160;

const pad = (n) => String(n).padStart(2, '0');
export const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export function greetingFor(now, name) {
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const who = String(name || '').trim().split(/\s+/)[0];
  return who ? `Good ${part}, ${who}` : `Good ${part}`;
}

export function dateLabel(now) {
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function startOfDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** "12" or, when the source was capped, "500+". */
export function countLabel(count, capped) {
  return typeof count === 'number' ? `${count}${capped ? '+' : ''}` : '—';
}

const humanize = (value) => String(value || '').replace(/[._-]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
const baseName = (path) => String(path || '').split('/').pop().replace(/\.md$/i, '');

const ACTION_VERBS = { proposed: 'Proposed', approved: 'You approved', rejected: 'You rejected', completed: 'Completed', failed: 'Failed' };
const FIXED_TITLES = {
  'routine.fired': 'Routine started', 'routine.completed': 'Routine completed', 'routine.failed': 'Routine failed',
  'email.sent': 'Email sent', 'notification.sent': 'Notification sent', 'task.created': 'Task created', 'task.completed': 'Task completed',
  'agent.memory_candidate.proposed': 'Proposed a memory for review', 'agent.memory_candidate.rejected': 'Memory proposal rejected',
  'memory.fact_recorded': 'Remembered a fact', 'memory.fact_corrected': 'Corrected a fact', 'memory.fact_reclassified': 'Reclassified a fact',
  'memory.fact_deleted': 'Forgot a fact', 'memory.entity_deleted': 'Deleted a record', 'commitment.made': 'Commitment recorded',
};

/** One journal entry -> {time, title, detail, tone}. */
export function describeEntry(entry) {
  const at = new Date(entry.ts);
  const type = String(entry.type || '');
  const data = entry.data || {};
  const action = /^agent\.action\.(\w+)$/.exec(type);
  let title = FIXED_TITLES[type] || humanize(type);
  let detail = '';
  if (action && ACTION_VERBS[action[1]]) title = `${ACTION_VERBS[action[1]]}: ${data.tool ? humanize(data.tool).toLowerCase() : 'an action'}`;
  if (type.startsWith('routine.')) {
    if (data.routine) detail = baseName(data.routine);
    if (data.reason) detail = `${detail}${detail ? ' · ' : ''}${humanize(data.reason).toLowerCase()}`;
  }
  const tone = /\.(failed)$/.test(type) ? 'danger' : /\.(completed|sent|approved)$/.test(type) ? 'success' : 'neutral';
  return { id: entry.eventId || `${entry.ts}-${type}`, time: Number.isNaN(at.getTime()) ? '' : clock(at), title, detail, tone };
}

/**
 * Today's slice of the journal (newest-first input). `completed` counts
 * agent.action.completed entries; `capped` says the endpoint's limit was reached
 * while still inside today, so the count may be low.
 */
export function summarizeJournal(journal, now = new Date()) {
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const since = startOfDay(now);
  const today = entries.filter((entry) => Date.parse(entry.ts) >= since);
  const completed = today.filter((entry) => entry.type === 'agent.action.completed').length;
  const capped = entries.length >= JOURNAL_LIMIT && today.length === entries.length;
  const items = today.slice(0, MAX_TIMELINE).reverse().map(describeEntry);
  return { total: today.length, completed, capped, items };
}

export function routineStatus(routine) {
  if (routine.error) return { id: 'invalid', label: 'Needs fixing', tone: 'danger' };
  if (!routine.enabled) return { id: 'paused', label: 'Disabled', tone: 'neutral' };
  if (routine.lastRun?.status === 'started') return { id: 'running', label: 'Running', tone: 'active' };
  return { id: 'enabled', label: 'Enabled', tone: 'success' };
}

export function lastRunLabel(run) {
  if (!run) return 'Never run';
  const names = { started: 'Running', completed: 'Completed', failed: 'Failed', throttled: 'Skipped' };
  const at = new Date(run.startedAt);
  const when = Number.isNaN(at.getTime()) ? '' : ` ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(at)}`;
  return `${names[run.status] || humanize(run.status)}${when}`;
}

/** Enabled, valid routines are "active"; the table lists them, capped. */
export function summarizeRoutines(payload) {
  const routines = Array.isArray(payload?.routines) ? payload.routines : [];
  const active = routines.filter((routine) => routine.enabled && !routine.error);
  return {
    total: routines.length,
    activeCount: active.length,
    inactiveCount: routines.length - active.length,
    rows: active.slice(0, MAX_ROUTINES).map((routine) => ({
      path: routine.path, name: routine.name || baseName(routine.path), status: routineStatus(routine),
      schedule: routine.schedule || 'Unknown', lastRun: lastRunLabel(routine.lastRun),
    })),
    hidden: Math.max(active.length - MAX_ROUTINES, 0),
  };
}

/** Pending approvals -> compact decision cards. No arguments are shown here; "Why?" and Operations hold the detail. */
export function decisionCards(payload) {
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  return actions.filter((a) => a?.id).map((a) => {
    const reason = String(a.reasoning_summary || a.reason || '').trim();
    return {
      id: a.id, tool: a.tool || null,
      title: `U2OS wants to ${a.tool ? humanize(a.tool).toLowerCase() : 'take an action'}`,
      reason: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason,
      policy: [a.policy_domain, a.policy_rule].filter(Boolean).join(' · '),
    };
  });
}

/** Everything below reports only what an endpoint returned; a missing field is "unknown". */
export function vaultTrust(vault) {
  const report = vault?.lastIndex;
  if (!report) return { id: 'vault', label: 'Vault', state: 'unknown', value: 'Not indexed yet' };
  const errors = Array.isArray(report.errors) ? report.errors.length : 0;
  const files = `${report.files} file${report.files === 1 ? '' : 's'}`;
  return errors
    ? { id: 'vault', label: 'Vault', state: 'warn', value: `${files} indexed, ${errors} with errors` }
    : { id: 'vault', label: 'Vault', state: 'ok', value: `${files} indexed` };
}

export function policyTrust(vault) {
  const policy = vault?.policy;
  if (!policy) return { id: 'policy', label: 'Policy', state: 'unknown', value: 'Unknown' };
  if (policy.error) return { id: 'policy', label: 'Policy', state: 'warn', value: 'Vault policy invalid; asking before every action' };
  return { id: 'policy', label: 'Policy', state: 'ok', value: policy.active ? 'Your vault policy is in effect' : 'Home policy is in effect' };
}

export function modelTrust(model) {
  const status = model?.runtimePlannerStatus || model?.plannerStatus;
  if (status === 'configured') return { id: 'model', label: 'Model', state: 'ok', value: model.restartRequired ? 'Configured; restart to apply changes' : 'Configured' };
  if (status === 'demo') return { id: 'model', label: 'Model', state: 'warn', value: 'Demo model only' };
  if (status === 'configuration-required') return { id: 'model', label: 'Model', state: 'warn', value: 'Not configured' };
  return { id: 'model', label: 'Model', state: 'unknown', value: 'Unknown' };
}

export function integrationsTrust(connectors) {
  const list = Array.isArray(connectors?.connectors) ? connectors.connectors : null;
  if (!list) return { id: 'integrations', label: 'Integrations', state: 'unknown', value: 'Unknown' };
  const real = list.filter((c) => c.active && c.active !== 'mock');
  const connected = real.filter((c) => c.connected).length;
  if (!real.length) return { id: 'integrations', label: 'Integrations', state: 'unknown', value: 'None connected' };
  return { id: 'integrations', label: 'Integrations', state: connected === real.length ? 'ok' : 'warn', value: `${connected} of ${real.length} connected` };
}

export const unavailableTrust = (id, label) => ({ id, label, state: 'unknown', value: 'Unavailable' });
