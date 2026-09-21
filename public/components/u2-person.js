import { emptyState, formatDateTime, humanizeKey } from './util.js';

export class U2Person extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected && !this._data) return;
    const data = this.data;
    this.textContent = '';
    this.classList.add('u2-domain-card');
    this.append(sectionTitle(data.name || 'Person', data.relationship));
    this.append(listSection('Key facts', data.facts, (fact) => `${humanizeKey(fact.key)}: ${formatValue(fact.value)}${fact.inferred ? ' (inferred)' : ''}`, (fact) => [fact.source, fact.classification].filter(Boolean).join(' · ')));
    this.append(listSection('Recent activity', data.recentActivity, (item) => `${item.label}${item.at ? ` — ${formatDateTime(item.at)}` : ''}`, (item) => item.source));
    this.append(listSection('Outstanding commitments', data.commitments, (item) => item.description, (item) => item.source));
    this.append(listSection('Upcoming interactions', data.upcomingInteractions, (item) => `${item.title}${item.at ? ` — ${formatDateTime(item.at)}` : ''}`));
  }
}

function sectionTitle(name, relationship) {
  const root = document.createElement('header'); root.className = 'u2-domain-card__header';
  const title = document.createElement('strong'); title.textContent = name; root.append(title);
  if (relationship) { const context = document.createElement('span'); context.textContent = relationship; root.append(context); }
  return root;
}

function listSection(title, items = [], label, meta = () => '') {
  const section = document.createElement('section');
  const heading = document.createElement('h4'); heading.textContent = title; section.append(heading);
  if (!items.length) { section.insertAdjacentHTML('beforeend', emptyState('None recorded.')); return section; }
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li'); const text = document.createElement('span'); text.textContent = label(item); li.append(text);
    const detail = meta(item); if (detail) { const small = document.createElement('small'); small.textContent = detail; li.append(small); }
    list.append(li);
  }
  section.append(list); return section;
}

function formatValue(value) { return typeof value === 'string' ? value : JSON.stringify(value); }

customElements.define('u2-person', U2Person);
