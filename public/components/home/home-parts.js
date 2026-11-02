import { el } from './home-util.js';
import {
  countLabel, summarizeJournal, summarizeRoutines, decisionCards, RECORD_LIMIT,
  vaultTrust, policyTrust, modelTrust, integrationsTrust, unavailableTrust,
} from './home-model.js';
import './u2-home-decision.js';

// Panel renderers for the Home overview. Each takes the host's per-source
// states ({status: 'loading' | 'ready' | 'error', data, error}) and returns a
// <section>. Every panel says what is loading, unavailable or empty.

const noteFor = (state, what, empty) => {
  if (state.status === 'loading') return el('p', { class: 'home-note', text: `Loading ${what}…` });
  if (state.status === 'error') return el('p', { class: 'home-note home-note--error', role: 'alert', text: `${what[0].toUpperCase()}${what.slice(1)} unavailable: ${state.error || 'the request failed'}.` });
  return empty ? el('p', { class: 'home-note', text: empty }) : null;
};

function panel(id, title, ...children) {
  return el('section', { class: 'home-panel', 'aria-labelledby': `home-${id}-title`, 'data-panel': id },
    el('div', { class: 'home-panel__head' }, el('h2', { class: 'home-panel__title', id: `home-${id}-title`, text: title }), children.shift()),
    ...children);
}

const link = (href, text) => el('a', { class: 'home-link', href, text });

export function header({ owner }, now, { greeting, date }) {
  return el('div', { class: 'home-header' },
    el('div', null,
      el('h1', { class: 'workspace__title home-greeting', text: greeting }),
      el('p', { class: 'home-sub', text: owner.status === 'error' ? 'Your name is unavailable right now.' : 'Here is where things stand.' })),
    el('div', { class: 'home-header__aside' },
      el('p', { class: 'home-date', text: date }),
      link('#/briefing', 'Open morning briefing')));
}

function tile(id, label, value, sub) {
  return el('li', { class: 'home-tile', 'data-tile': id }, el('span', { class: 'home-tile__value', text: value }), el('span', { class: 'home-tile__label', text: label }), sub && el('span', { class: 'home-tile__sub', text: sub }));
}

export function tiles({ pending, routines, journal }, now) {
  const value = (state, fn) => (state.status === 'ready' ? fn(state.data) : state.status === 'loading' ? '…' : '—');
  const unavailable = (state) => (state.status === 'error' ? 'Unavailable' : null);
  const day = journal.status === 'ready' ? summarizeJournal(journal.data, now) : null;
  const rs = routines.status === 'ready' ? summarizeRoutines(routines.data) : null;
  return el('ul', { class: 'home-tiles', 'aria-label': 'Summary' },
    tile('review', 'Need your review', value(pending, (d) => String(decisionCards(d).length)), unavailable(pending)),
    tile('routines', 'Routines active', rs ? String(rs.activeCount) : value(routines, () => '—'), unavailable(routines)),
    tile('completed', 'Actions completed today', day ? countLabel(day.completed, day.capped) : value(journal, () => '—'), unavailable(journal) || (day?.capped ? 'Journal limit reached' : null)));
}

export function timeline({ journal }, now) {
  const day = journal.status === 'ready' ? summarizeJournal(journal.data, now) : null;
  const note = noteFor(journal, 'your journal', day && !day.items.length ? 'Nothing has been journaled today yet.' : null);
  const items = day?.items.length ? el('ol', { class: 'home-timeline' }, ...day.items.map((item) => el('li', { class: `home-timeline__item home-timeline__item--${item.tone}`, 'data-entry': item.id },
    el('time', { class: 'home-timeline__time', text: item.time }),
    el('div', null, el('span', { class: 'home-timeline__title', text: item.title }), item.detail && el('span', { class: 'home-timeline__detail', text: item.detail }))))) : null;
  return panel('timeline', 'Your day, handled', link('#/vault', 'View journal'), note, items);
}

export function routinesPanel({ routines }) {
  const rs = routines.status === 'ready' ? summarizeRoutines(routines.data) : null;
  let empty = null;
  if (rs && !rs.rows.length) empty = rs.total ? `No routines are enabled (${rs.inactiveCount} disabled or needing a fix).` : 'No routines yet. Add a Markdown file to the routines folder of your vault.';
  const table = rs?.rows.length ? el('div', { class: 'home-table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Active routines, scrollable' }, el('table', { class: 'home-table' },
    el('caption', { class: 'sr-only', text: 'Active routines' }),
    el('thead', null, el('tr', null, ...['Name', 'Status', 'Schedule', 'Last run'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', null, ...rs.rows.map((row) => el('tr', { 'data-routine': row.path },
      el('th', { scope: 'row', text: row.name }),
      el('td', null, el('span', { class: `home-status home-status--${row.status.tone}`, text: row.status.label })),
      el('td', { text: row.schedule }), el('td', { text: row.lastRun })))))) : null;
  const more = rs?.hidden ? el('p', { class: 'home-note', text: `${rs.hidden} more enabled. See Routines.` }) : null;
  return panel('routines', 'Active routines', link('#/routines', 'Manage routines'), noteFor(routines, 'routines', empty), table, more);
}

export function world({ people, projects, commitments }) {
  const cell = (label, state, href, capped) => el('li', { class: 'home-world__item' }, el('a', { href },
    el('span', { class: 'home-world__label', text: label }),
    el('span', { class: 'home-world__count', text: state.status === 'ready' ? countLabel(state.data, capped(state.data)) : state.status === 'loading' ? '…' : 'Unavailable' })));
  const capped = (n) => n >= RECORD_LIMIT;
  return panel('world', 'Your world', null,
    el('ul', { class: 'home-world' }, cell('People', people, '#/people', capped), cell('Projects', projects, '#/projects', capped), cell('Commitments', commitments, '#/memory', () => false)));
}

export function decisions({ pending }) {
  const cards = pending.status === 'ready' ? decisionCards(pending.data) : [];
  const empty = pending.status === 'ready' && !cards.length ? 'Nothing needs your decision right now.' : null;
  const list = cards.length ? el('div', { class: 'home-decisions' }, ...cards.map((card) => { const node = el('u2-home-decision', { 'data-action-id': card.id }); node.card = card; return node; })) : null;
  return panel('decisions', 'Needs your decision', link('#/operations', 'Operations'), noteFor(pending, 'pending decisions', empty), list);
}

export function trust({ vault, model, connectors }) {
  const pick = (state, id, label, fn) => (state.status === 'ready' ? fn(state.data) : unavailableTrust(id, label));
  const items = [
    pick(vault, 'vault', 'Vault', vaultTrust), pick(vault, 'policy', 'Policy', policyTrust),
    pick(model, 'model', 'Model', modelTrust), pick(connectors, 'integrations', 'Integrations', integrationsTrust),
  ];
  const loading = [vault, model, connectors].some((s) => s.status === 'loading');
  return panel('trust', 'System trust', link('#/diagnostics', 'Diagnostics'),
    loading ? el('p', { class: 'home-note', text: 'Checking system status…' }) : null,
    el('ul', { class: 'home-trust' }, ...items.map((item) => el('li', { class: `home-trust__item home-trust__item--${item.state}`, 'data-trust': item.id },
      el('span', { class: 'home-trust__label', text: item.label }), el('span', { class: 'home-trust__value', text: item.value })))));
}

export function ask(onSubmit) {
  const input = el('input', { class: 'home-ask__input', id: 'home-ask-input', type: 'text', name: 'ask', autocomplete: 'off', placeholder: 'Ask U2…', maxlength: 2000 });
  const note = el('p', { class: 'home-note', role: 'status', 'aria-live': 'polite' });
  const form = el('form', { class: 'home-ask', 'aria-label': 'Ask U2' },
    el('label', { class: 'sr-only', for: 'home-ask-input', text: 'Ask U2' }), input,
    el('button', { type: 'submit', class: 'btn btn-primary', text: 'Ask' }), note);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const result = onSubmit(text);
    if (result === true) { input.value = ''; note.textContent = 'Sent to the agent panel.'; }
    else note.textContent = result === 'busy' ? 'The agent is still working on a request. Try again in a moment.' : 'The agent panel is unavailable.';
  });
  return form;
}
