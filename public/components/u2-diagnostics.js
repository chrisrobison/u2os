import * as api from '../services/api.js';

const REFRESH_EVENTS = ['agent.action.', 'connector.', 'memory.', 'model.'];

export class U2Diagnostics extends HTMLElement {
  constructor() {
    super();
    this._onEvent = (event) => {
      const type = event.detail?.type || '';
      if (REFRESH_EVENTS.some((prefix) => type.startsWith(prefix))) this.load();
    };
  }

  connectedCallback() {
    window.addEventListener('u2-event', this._onEvent);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
  }

  async load() {
    this.replaceChildren(header(), loading());
    try {
      const data = await api.getDiagnostics();
      this.replaceChildren(header(), renderDiagnostics(data));
    } catch (error) {
      const failure = document.createElement('div');
      failure.className = 'load-error';
      failure.textContent = `Couldn't load diagnostics: ${error.message}`;
      this.replaceChildren(header(), failure);
    }
  }
}

function header() {
  const node = document.createElement('div');
  node.className = 'workspace__header';
  const title = document.createElement('h1');
  title.className = 'workspace__title';
  title.textContent = 'Diagnostics';
  const subtitle = document.createElement('p');
  subtitle.className = 'workspace__subtitle';
  subtitle.textContent = 'Local operational health. Secrets and private content are excluded.';
  node.append(title, subtitle);
  return node;
}

function loading() {
  const node = document.createElement('div');
  node.className = 'empty-state';
  node.textContent = 'Checking U2OS health…';
  return node;
}

function renderDiagnostics(data) {
  const root = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'diagnostics-status';
  status.dataset.state = data.status;
  status.setAttribute('role', 'status');
  status.textContent = `System ${data.status}`;
  root.appendChild(status);

  const overview = document.createElement('div');
  overview.className = 'diagnostics-overview';
  overview.append(
    metricCard('Server', [['Uptime', duration(data.server.uptimeSeconds)], ['SSE clients', data.server.sseClientCount]]),
    metricCard('Database', [['Size', bytes(data.database.sizeBytes)], ['Events', data.database.eventCount], ['State', data.database.state]]),
    metricCard('Actions', [['Waiting approval', data.actions.pendingApproval], ['Queued', data.actions.queued], ['Retrying', data.actions.retrying], ['Failed', data.actions.failed], ['Dead letters', data.actions.deadLetters], ['Completed', data.actions.completed]]),
    metricCard('Memory', [['Entities', data.memory.entities], ['Current facts', data.memory.facts]]),
  );
  root.appendChild(overview);

  const dependencies = document.createElement('div');
  dependencies.className = 'diagnostics-grid';
  dependencies.append(
    dependencyCard('Models', [data.model, data.embeddings].map((item, index) => ({ ...item, label: index ? 'Embeddings' : 'Planner' }))),
    dependencyCard('Connectors', data.connectors.map((item) => ({ ...item, label: item.domain, detail: item.lastSuccessfulSync ? `Last sync ${dateTime(item.lastSuccessfulSync)}` : null }))),
  );
  root.appendChild(dependencies);
  root.appendChild(errorCard(data.recentErrors || []));
  return root;
}

function metricCard(titleText, rows) {
  const card = document.createElement('section');
  card.className = 'diagnostics-card';
  const title = document.createElement('h2');
  title.textContent = titleText;
  const list = document.createElement('dl');
  for (const [label, value] of rows) {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = String(value ?? 'Unavailable');
    list.append(term, detail);
  }
  card.append(title, list);
  return card;
}

function dependencyCard(titleText, items) {
  const card = document.createElement('section');
  card.className = 'diagnostics-card';
  const title = document.createElement('h2'); title.textContent = titleText;
  card.appendChild(title);
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'diagnostics-dependency';
    const label = document.createElement('span'); label.textContent = item.label;
    const meta = document.createElement('span'); meta.className = 'diagnostics-dependency__meta';
    meta.textContent = `${item.state}${item.provider ? ` · ${item.provider}` : ''}${item.detail ? ` · ${item.detail}` : ''}`;
    row.append(label, meta); card.appendChild(row);
  }
  return card;
}

function errorCard(items) {
  const card = document.createElement('section'); card.className = 'diagnostics-card';
  const title = document.createElement('h2'); title.textContent = 'Recent warnings and errors';
  card.appendChild(title);
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = 'None recorded since this server started.'; card.appendChild(empty);
    return card;
  }
  const list = document.createElement('ul'); list.className = 'diagnostics-errors';
  for (const item of items) {
    const entry = document.createElement('li');
    const summary = document.createElement('span'); summary.textContent = `${item.component}: ${item.message} `;
    const time = document.createElement('time'); time.dateTime = item.timestamp; time.textContent = dateTime(item.timestamp);
    entry.append(summary, time); list.appendChild(entry);
  }
  card.appendChild(list); return card;
}

function duration(seconds = 0) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function bytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

customElements.define('u2-diagnostics', U2Diagnostics);
