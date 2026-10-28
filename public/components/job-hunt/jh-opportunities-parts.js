import { el, fitBand, monogram } from './jh-util.js';
import { formatCount } from './jh-overview-model.js';
import { FILTER_TABS, compensationText, fitText, jobPageHref, locationText, pageCount, postedText, rangeText, statusOf } from './jh-opportunities-model.js';
import './jh-all.js';

// The sections of the Opportunities table (#631), each a function from data to DOM. Every string from the data is
// written with textContent (through el()), links are built from validated job ids, and behaviour is attached by the host
// through delegation on data-* attributes, so these functions hold no listeners.

/** Quick-filter tabs with their counts. A count the server did not send is a dash, never a zero. */
export function filterTabs(state, counts) {
  return el('div', { class: 'jh-opp__tabs', role: 'group', 'aria-label': 'Filter opportunities' }, FILTER_TABS.map((tab) => el('button', {
    type: 'button', class: 'jh-opp__tab', 'data-filter': tab.id, 'aria-pressed': String(state.filter === tab.id),
  }, tab.label, el('span', { class: 'jh-opp__count', 'data-count': tab.id, text: formatCount(counts?.[tab.id]) }))));
}

/** The stage or status scope a link from the Overview applied, each with a way to remove it. */
export function scopeChips(state, stageLabel) {
  const chips = [];
  if (state.stage) chips.push(['stage', state.stage === 'needs_input' ? 'Needs Input' : (stageLabel ?? state.stage)]);
  if (state.statuses?.length) chips.push(['statuses', state.statuses.map((status) => status.replace(/_/g, ' ')).join(', ')]);
  return el('div', { class: 'jh-opp__chips', 'aria-label': 'Applied filters' }, chips.map(([key, text]) => el('span', { class: 'jh-opp__chip', 'data-scope': key },
    el('span', { text: key === 'stage' ? `Stage: ${text}` : `Status: ${text}` }),
    el('button', { type: 'button', class: 'jh-opp__chip-x', 'data-action': 'clear-scope', 'data-scope': key, 'aria-label': `Remove ${key === 'stage' ? 'stage' : 'status'} filter`, text: '×' }))));
}

export function bulkBar(selected, busy) {
  return el('div', { class: 'jh-opp__bulk', role: 'group', 'aria-label': 'Bulk actions' },
    el('span', { class: 'jh-opp__bulk-count', 'data-part': 'selected-count', text: `${formatCount(selected)} selected` }),
    el('button', { type: 'button', class: 'btn', 'data-action': 'bulk-reject', disabled: busy ? '' : null, text: 'Reject selected' }),
    el('button', { type: 'button', class: 'btn', 'data-action': 'clear-selection', disabled: busy ? '' : null, text: 'Clear selection' }));
}

const COLUMNS = [
  ['company', 'Company', true], ['role', 'Role', true], ['location', 'Location', false], ['comp', 'Compensation', false],
  ['fit', 'Fit score', true], ['status', 'Status', true], ['posted', 'Posted', true],
];
const SORT_KEY = { company: 'company', role: 'role', fit: 'fit', status: 'status', posted: 'posted' };

function headerRow(ctx) {
  const pageIds = ctx.items.map((item) => item.id);
  const picked = pageIds.filter((id) => ctx.checked.has(id)).length;
  const all = el('input', { type: 'checkbox', 'data-select-all': '', 'aria-label': 'Select all opportunities on this page', 'data-roving': '' });
  all.checked = pickedAll(picked, pageIds.length);
  all.indeterminate = picked > 0 && picked < pageIds.length;
  return el('tr', { role: 'row', 'aria-rowindex': '1' },
    el('th', { role: 'columnheader', class: 'jh-opp__check', scope: 'col' }, all),
    COLUMNS.map(([id, label, sortable]) => {
      const key = SORT_KEY[id];
      const sorted = sortable && ctx.state.sort === key;
      return el('th', { role: 'columnheader', scope: 'col', 'data-col': id, 'aria-sort': sorted ? (ctx.state.dir === 'asc' ? 'ascending' : 'descending') : null },
        sortable
          ? el('button', { type: 'button', class: 'jh-opp__sort', 'data-sort': key, 'data-roving': '' }, label, el('span', { class: 'jh-opp__arrow', 'aria-hidden': 'true', text: sorted ? (ctx.state.dir === 'asc' ? '↑' : '↓') : '' }))
          : label);
    }),
    el('th', { role: 'columnheader', scope: 'col', class: 'jh-opp__actions-head' }, el('span', { class: 'jh-opp__sr', text: 'Actions' })));
}

const pickedAll = (picked, total) => total > 0 && picked === total;

function dataRow(item, ctx, index) {
  const href = jobPageHref(item.id);
  const label = [item.role, item.company].filter(Boolean).join(' at ') || 'this job';
  const box = el('input', { type: 'checkbox', 'data-select': item.id, 'data-roving': '', 'aria-label': `Select ${label}` });
  box.checked = ctx.checked.has(item.id);
  const [tone, statusLabel] = statusOf(item);
  const fit = el('span', { class: `jh-fit jh-fit--${fitBand(item.fit)}`, 'data-part': 'fit', text: fitText(item) });
  if (typeof item.fit === 'number') fit.setAttribute('aria-label', `Fit score ${item.fit}`);
  const menu = el('u2-job-menu');
  menu.job = { id: item.id, company: item.company, role: item.role, status: item.status };
  const roleCell = item.role && href ? el('a', { class: 'jh-link jh-opp__role', href, 'data-roving': '', 'data-part': 'role', text: item.role }) : el('span', { 'data-part': 'role', text: item.role || '—' });
  return el('tr', {
    role: 'row', 'data-job': item.id, 'aria-rowindex': String((ctx.state.page - 1) * ctx.limit + index + 2), 'aria-selected': String(ctx.checked.has(item.id)),
    'aria-current': ctx.currentId === item.id ? 'true' : null, 'data-current': ctx.currentId === item.id ? '' : null, tabindex: '-1',
  },
  el('td', { role: 'gridcell', class: 'jh-opp__check' }, box),
  el('td', { role: 'gridcell', 'data-col': 'company' }, el('span', { class: 'jh-opp__who' }, monogram(item.company, 'md'), el('span', { class: 'jh-opp__company', 'data-part': 'company', text: item.company }))),
  el('td', { role: 'gridcell', 'data-col': 'role' }, roleCell),
  el('td', { role: 'gridcell', 'data-col': 'location', 'data-part': 'location', text: locationText(item) }),
  el('td', { role: 'gridcell', 'data-col': 'comp', 'data-part': 'comp', text: compensationText(item) }),
  el('td', { role: 'gridcell', 'data-col': 'fit' }, fit),
  el('td', { role: 'gridcell', 'data-col': 'status' }, el('jh-status-label', { tone, label: statusLabel, 'data-part': 'status' })),
  el('td', { role: 'gridcell', 'data-col': 'posted', 'data-part': 'posted', text: postedText(item) }),
  el('td', { role: 'gridcell', class: 'jh-opp__actions' }, menu));
}

/** The grid. `ctx`: { items, state, total, limit, checked: Set, currentId }. */
export function opportunityGrid(ctx) {
  return el('div', { class: 'jh-opp__scroll' }, el('table', {
    class: 'jh-opp__table', role: 'grid', 'aria-label': 'Opportunities', 'aria-multiselectable': 'true',
    'aria-rowcount': String(ctx.total + 1), 'aria-colcount': String(COLUMNS.length + 2),
  }, el('thead', { role: 'rowgroup' }, headerRow(ctx)), el('tbody', { role: 'rowgroup' }, ctx.items.map((item, index) => dataRow(item, ctx, index)))));
}

/** Makes exactly one row (and its controls) a tab stop. Returns the id of the row that has it. */
export function applyTabStops(root, activeId) {
  const rows = root.querySelectorAll('tr[data-job]');
  const target = [...rows].find((row) => row.getAttribute('data-job') === activeId) ?? rows[0] ?? null;
  for (const row of rows) {
    const on = row === target;
    row.setAttribute('tabindex', on ? '0' : '-1');
    for (const control of row.querySelectorAll('[data-roving], [data-row-action]')) control.setAttribute('tabindex', on ? '0' : '-1');
  }
  return target ? target.getAttribute('data-job') : null;
}

export function pager(state, total, limit, shown) {
  const pages = pageCount(total, limit);
  return el('nav', { class: 'jh-opp__pager', 'aria-label': 'Pagination' },
    el('span', { class: 'jh-opp__range', 'data-part': 'range', role: 'status', text: rangeText(state.page, limit, total, shown) }),
    el('span', { class: 'jh-opp__pages' },
      el('button', { type: 'button', class: 'btn', 'data-page': 'prev', disabled: state.page <= 1 ? '' : null, text: 'Previous' }),
      el('span', { class: 'jh-opp__page', 'data-part': 'page', text: `Page ${formatCount(state.page)} of ${formatCount(pages)}` }),
      el('button', { type: 'button', class: 'btn', 'data-page': 'next', disabled: state.page >= pages ? '' : null, text: 'Next' })));
}
