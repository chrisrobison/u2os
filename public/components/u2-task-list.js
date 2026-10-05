import { escapeHtml, formatDate, emptyState } from './util.js';

// property `tasks` -> array as returned by GET /api/tasks.
export class U2TaskList extends HTMLElement {
  constructor() {
    super();
    this._tasks = [];
  }

  set tasks(list) {
    this._tasks = Array.isArray(list) ? list : [];
    this._render();
  }

  get tasks() {
    return this._tasks;
  }

  connectedCallback() {
    this._render();
    if (this._bound) return;
    this._bound = true;
    // `selectable` rows are buttons that announce the chosen task (#434).
    // Dashboard cards use the list without the attribute and stay read-only.
    this.addEventListener('click', (event) => {
      if (!this.hasAttribute('selectable')) return;
      const row = event.target.closest('[data-task-id]');
      if (!row) return;
      const task = this._tasks.find((t) => t.id === row.dataset.taskId);
      if (task) this.dispatchEvent(new CustomEvent('u2-task-select', { bubbles: true, detail: { task, opener: row } }));
    });
  }

  _render() {
    this.classList.add('u2-task-list');
    if (!this._tasks.length) {
      this.innerHTML = emptyState('No tasks right now.');
      return;
    }

    this.innerHTML = this._tasks
      .map((task) => {
        const isCompleted = task.status === 'completed';
        const due = task.due_at ? formatDate(task.due_at) : '';
        const tag = this.hasAttribute('selectable') ? 'button type="button"' : 'div';
        const end = this.hasAttribute('selectable') ? 'button' : 'div';
        return `
          <${tag} class="u2-task${this.hasAttribute('selectable') ? ' u2-task--select' : ''}" data-task-id="${escapeHtml(task.id)}">
            <span class="status-dot ${isCompleted ? 'is-completed' : 'is-open'}"></span>
            <span class="u2-task__title ${isCompleted ? 'is-completed' : ''}">${escapeHtml(task.title)}</span>
            ${due ? `<span class="u2-task__due">${escapeHtml(due)}</span>` : ''}
          </${end}>
        `;
      })
      .join('');
  }
}

customElements.define('u2-task-list', U2TaskList);
