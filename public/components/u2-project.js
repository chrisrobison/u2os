import { emptyState, formatDateTime } from './util.js';

export class U2Project extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-domain-card');
    const header = document.createElement('header'); header.className = 'u2-domain-card__header';
    const title = document.createElement('strong'); title.textContent = d.name || 'Project'; header.append(title);
    const status = document.createElement('span'); status.className = 'badge'; status.textContent = d.status || 'unknown'; header.append(status); this.append(header);
    this.append(items('Open tasks', d.openTasks, (x) => `${x.title}${x.dueAt ? ` — due ${formatDateTime(x.dueAt)}` : ''}`));
    this.append(items('People', d.people, (x) => x.name));
    this.append(items('Deadlines', d.deadlines, (x) => `${x.label} — ${formatDateTime(x.at)}`));
    this.append(items('Unresolved decisions', d.unresolvedDecisions, (x) => x.label));
    this.append(items('Related documents', d.relatedDocuments, (x) => x.title || x.label));
    this.append(items('Recent activity', d.recentActivity, (x) => `${x.label}${x.at ? ` — ${formatDateTime(x.at)}` : ''}`));
  }
}

function items(title, values = [], describe) {
  const section = document.createElement('section'); const heading = document.createElement('h4'); heading.textContent = title; section.append(heading);
  if (!values.length) { section.insertAdjacentHTML('beforeend', emptyState('None recorded.')); return section; }
  const list = document.createElement('ul'); for (const value of values) { const li = document.createElement('li'); li.textContent = describe(value); list.append(li); } section.append(list); return section;
}

customElements.define('u2-project', U2Project);
