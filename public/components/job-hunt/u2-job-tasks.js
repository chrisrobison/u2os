import * as api from '../../services/api.js';
import { el, svg, monogram } from './jh-util.js';

// Tasks & Follow-ups: a checklist from the dashboard's `tasks` (open first,
// soonest due first, then the last week's completed). Generated follow-ups
// from sent emails sit in the same list. Rows: a checkbox (complete / undo),
// the title, the owner's company link, a due label (overdue and today carry
// state tones) and a Snooze action.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayName = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** { text, tone } for a task: tone is 'overdue', 'today', 'done' or 'normal'. */
export function dueLabel(task, now = new Date()) {
  if (task.doneAt) return { text: 'Done', tone: 'done' };
  if (!task.dueAt) return { text: 'No due date', tone: 'normal' };
  const due = new Date(task.dueAt);
  const tomorrow = new Date(now.getTime() + DAY);
  if (sameDay(due, now)) return { text: `Today, ${clock(due)}`, tone: due < now ? 'overdue' : 'today' };
  if (due < now) return { text: `Overdue · ${dayName(due)}`, tone: 'overdue' };
  if (sameDay(due, tomorrow)) return { text: `Tomorrow, ${clock(due)}`, tone: 'normal' };
  return { text: dayName(due), tone: 'normal' };
}

/** How many open tasks are due within the next 7 days (overdue ones included). */
export function dueThisWeek(tasks, now = Date.now()) {
  return tasks.filter((task) => !task.doneAt && task.dueAt && Date.parse(task.dueAt) < now + WEEK).length;
}

function clockIcon() {
  return svg('svg', { class: 'jh-ico', viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { cx: 12, cy: 12, r: 8, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    svg('path', { d: 'M12 8v4l3 2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
}

export class U2JobTasks extends HTMLElement {
  constructor() { super(); this._built = false; this._tasks = null; this._error = null; this._busy = new Set(); }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.classList.add('jh-panel');
      this.setAttribute('role', 'region');
      this.setAttribute('aria-labelledby', 'jh-tasks-title');
      this._count = el('span', { class: 'jh-panel__meta' });
      this._alert = el('p', { class: 'load-error', role: 'alert', hidden: true });
      this._body = el('div');
      this.append(el('div', { class: 'jh-panel__head' }, el('div', { class: 'jh-panel__titles' }, el('h2', { id: 'jh-tasks-title', class: 'jh-panel__title', text: 'Tasks & Follow-ups' }), this._count)), this._alert, this._body);
    }
    this._render();
  }

  update(tasks) {
    this._tasks = tasks;
    if (this._built) this._render();
  }

  /** Re-labels due times against the clock without new data. */
  tick() { if (this._built && this._tasks) this._render(); }

  _render() {
    if (!this._tasks) return;
    const focused = this._body.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
    this._body.textContent = '';
    const due = dueThisWeek(this._tasks);
    this._count.textContent = due ? `${due} due this week` : '';
    if (!this._tasks.length) {
      this._body.append(el('p', { class: 'jh-empty', text: 'No tasks yet. Follow-ups appear once you send an application; add your own from a job’s details.' }));
      return;
    }
    this._body.append(el('ul', { class: 'jh-tasks' }, this._tasks.map((task) => this._row(task))));
    if (focused) this._body.querySelector(`[data-focus-key="${focused}"]`)?.focus();
  }

  _row(task) {
    const label = dueLabel(task);
    const busy = this._busy.has(task.id);
    const box = el('input', { type: 'checkbox', class: 'jh-check', id: `jh-task-${task.id}`, 'data-focus-key': `check-${task.id}`, disabled: busy });
    box.checked = Boolean(task.doneAt);
    box.addEventListener('change', () => this._toggle(task, box.checked));
    const company = el('button', { type: 'button', class: 'jh-linkbtn', text: task.company });
    company.addEventListener('click', () => this.dispatchEvent(new CustomEvent('jh-select', { bubbles: true, detail: { id: task.jobId } })));
    const snooze = el('button', { type: 'button', class: 'jh-mini', 'data-focus-key': `snooze-${task.id}`, 'aria-label': `Snooze ${task.title} for a day`, disabled: busy, text: 'Snooze' });
    snooze.addEventListener('click', () => this._snooze(task));
    return el('li', { class: `jh-task${task.doneAt ? ' jh-task--done' : ''}` },
      box,
      el('div', { class: 'jh-task__body' },
        el('label', { class: 'jh-task__title', for: `jh-task-${task.id}`, text: task.title }),
        el('div', { class: 'jh-task__meta' }, monogram(task.company, 'sm'), company, task.snoozedUntil ? el('span', { class: 'jh-task__snoozed', text: 'Snoozed' }) : null)),
      el('div', { class: 'jh-task__side' },
        el('span', { class: `jh-due jh-due--${label.tone}` }, label.tone === 'overdue' || label.tone === 'today' ? clockIcon() : null, el('span', { text: label.text })),
        task.doneAt ? null : snooze));
  }

  async _mutate(task, run) {
    this._busy.add(task.id);
    this._alert.hidden = true;
    this._render();
    try {
      await run();
      this.dispatchEvent(new CustomEvent('jh-changed', { bubbles: true, detail: { id: task.jobId } }));
    } catch (err) {
      this._alert.hidden = false;
      this._alert.textContent = `Couldn't update the task: ${err.message}`;
    }
    this._busy.delete(task.id);
    this._render();
  }

  _toggle(task, done) { return this._mutate(task, () => api.setJobHuntTaskDone(task.id, done)); }

  _snooze(task) { return this._mutate(task, () => api.snoozeJobHuntTask(task.id, 1)); }
}

customElements.define('u2-job-tasks', U2JobTasks);
