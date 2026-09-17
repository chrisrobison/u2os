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
        return `
          <div class="u2-task">
            <span class="status-dot ${isCompleted ? 'is-completed' : 'is-open'}"></span>
            <span class="u2-task__title ${isCompleted ? 'is-completed' : ''}">${escapeHtml(task.title)}</span>
            ${due ? `<span class="u2-task__due">${escapeHtml(due)}</span>` : ''}
          </div>
        `;
      })
      .join('');
  }
}

customElements.define('u2-task-list', U2TaskList);
