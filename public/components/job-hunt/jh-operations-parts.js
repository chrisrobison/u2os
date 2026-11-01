import { el, relTime } from './jh-util.js';
import { APPROVALS_HREF, AUTOPILOT_EXECUTION, AUTOPILOT_MODE, DASH, MODE_EXPLANATION, countText, jobLabel, rowJobHref, statusOf } from './jh-operations-model.js';
import './jh-all.js';

// The sections of the Agent Operations view (#640), each a function from the /api/job-hunt/operations payload to DOM.
// Read only by construction: the only interactive elements are links. Strings are written with textContent (through
// el()) and links are built from validated ids.

const card = (title, ...children) => el('section', { class: 'jh-panel jh-ov__panel', 'aria-label': title }, ...children);
const head = (title, meta, link) => el('div', { class: 'jh-panel__head' }, el('h2', { class: 'jh-panel__title', text: title }), meta ? el('span', { class: 'jh-panel__meta', text: meta }) : null, link);
const empty = (title, message) => el('jh-state', { kind: 'empty', title, message });
const when = (iso, now) => (iso ? relTime(iso, now) || DASH : DASH);

function jobCell(row) {
  const href = rowJobHref(row);
  const who = jobLabel(row);
  return href ? el('a', { class: 'jh-link', href, text: who }) : el('span', { class: 'jh-ov__muted', text: who });
}

function actionRow(row, now, { time = 'at', note = null } = {}) {
  const [tone, label] = statusOf(row.status);
  return el('li', { class: 'jh-ov__event jh-ops__row', 'data-action': row.id ?? null, 'data-status': row.status },
    el('jh-status-label', { tone, label }),
    el('span', { class: 'jh-ops__what', text: row.label }),
    jobCell(row),
    el('span', { class: 'jh-ov__muted', text: when(row[time], now) }),
    note ? el('span', { class: 'jh-ops__note', text: note }) : null);
}

export function autopilotPanel(data) {
  const state = data.autopilot;
  if (!state) {
    return card('Autopilot', head('Autopilot'), el('p', { class: 'jh-ov__muted', 'data-autopilot': 'unavailable', text: `${DASH} The autopilot is not available on this server.` }));
  }
  const [modeTone, modeText] = AUTOPILOT_MODE[state.mode] ?? ['neutral', DASH];
  const [execTone, execText] = AUTOPILOT_EXECUTION[state.execution] ?? ['neutral', DASH];
  const cycle = state.lastCycle;
  return card('Autopilot',
    head('Autopilot', null, el('a', { class: 'jh-link', href: '#/job-hunt/leads', text: 'Autopilot controls' })),
    el('div', { class: 'jh-ov__autopilot', 'data-autopilot': state.mode, 'data-execution': state.execution },
      el('span', { class: 'jh-ov__autopilot-item' }, el('span', { class: 'jh-ov__muted', text: 'Mode' }), el('jh-status-label', { tone: modeTone, label: modeText, 'data-part': 'mode' })),
      el('span', { class: 'jh-ov__autopilot-item' }, el('span', { class: 'jh-ov__muted', text: 'Status' }), el('jh-status-label', { tone: execTone, label: execText, 'data-part': 'execution' }))),
    el('p', { class: 'jh-note', 'data-part': 'mode-note', text: MODE_EXPLANATION[state.mode] ?? DASH }),
    state.detail ? el('p', { class: 'load-error', 'data-part': 'detail', text: state.detail }) : null,
    el('dl', { class: 'jh-ops__facts' },
      el('div', null, el('dt', { text: 'Last cycle finished' }), el('dd', { 'data-part': 'last-cycle', text: when(state.lastRunAt) })),
      el('div', null, el('dt', { text: 'Actions in that cycle' }), el('dd', { text: countText(cycle?.actions) })),
      el('div', null, el('dt', { text: 'Needed you' }), el('dd', { text: countText(cycle?.needsYou) })),
      el('div', null, el('dt', { text: 'Errors' }), el('dd', { text: countText(cycle?.errors) })),
      el('div', null, el('dt', { text: 'Settings last changed' }), el('dd', { text: when(state.settingsChangedAt) }))));
}

export function runningPanel(data, now = Date.now()) {
  const { count, items } = data.running;
  return card('Running now',
    head('Running Now', `${count}`),
    items.length ? el('ul', { class: 'jh-ov__list' }, items.map((row) => actionRow(row, now, { time: 'since', note: row.attempts > 1 ? `attempt ${row.attempts}` : null })))
      : empty('Nothing is running', 'Actions the agent has started, or is waiting to retry, appear here.'));
}

export function approvalsPanel(data, now = Date.now()) {
  const { count, items } = data.awaitingApproval;
  return card('Awaiting your approval',
    head('Awaiting Your Approval', null, count ? el('a', { class: 'jh-link', href: APPROVALS_HREF, 'data-part': 'approvals-link', text: 'Review in Operations' }) : null),
    el('span', { class: 'jh-ov__badge', 'data-part': 'approval-count', text: String(count) }),
    items.length ? el('ul', { class: 'jh-ov__list' }, items.map((row) => actionRow(row, now, { time: 'since' })))
      : empty('Nothing is waiting for you', 'Actions your policies say to ask about appear here. You approve or reject them in Operations.'),
    count > items.length ? el('p', { class: 'jh-note', text: `Showing ${items.length} of ${count}.` }) : null);
}

export function failuresPanel(data, now = Date.now()) {
  const items = data.failures;
  return card('Recent failures and errors',
    head('Recent Failures and Errors', `${items.length}`),
    items.length ? el('ul', { class: 'jh-ov__list' }, items.map((row) => el('li', { class: 'jh-ov__item', 'data-source': row.source },
      el('div', { class: 'jh-ov__item-body' },
        el('div', { class: 'jh-ov__item-who' }, el('strong', { text: row.label }), ' ', jobCell(row)),
        el('div', { class: 'jh-ov__item-why', 'data-part': 'message', text: row.message ?? DASH }),
        el('div', { class: 'jh-ov__muted', text: `${statusOf(row.status)[1]} · ${when(row.at, now)}` })))))
      : empty('No recent failures', 'Failed or blocked actions and autopilot errors appear here.'));
}

export function recentPanel(data, now = Date.now()) {
  return card('Recent agent actions',
    head('Recent Agent Actions', null, el('a', { class: 'jh-link', href: '#/applications', text: 'Application ledger' })),
    data.recent.length ? el('ul', { class: 'jh-ov__list jh-ov__timeline' }, data.recent.map((row) => actionRow(row, now)))
      : empty('No agent actions yet', 'Applications the agent prepared, proposed or sent show up here.'));
}

export function activityPanel(data, now = Date.now()) {
  const last = data.lastActivity ?? {};
  return card('Last activity',
    head('Last Activity'),
    el('dl', { class: 'jh-ops__facts' },
      el('div', null, el('dt', { text: 'Autopilot cycle' }), el('dd', { 'data-part': 'last-cycle-at', text: when(last.autopilotCycleAt, now) })),
      el('div', null, el('dt', { text: 'Agent action' }), el('dd', { 'data-part': 'last-action-at', text: when(last.lastActionAt, now) })),
      el('div', null, el('dt', { text: 'Failure' }), el('dd', { 'data-part': 'last-failure-at', text: when(last.lastFailureAt, now) }))));
}
