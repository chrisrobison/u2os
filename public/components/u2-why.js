import { getActionExplanation, getRecommendationExplanation } from '../services/api.js';

function humanize(value) {
  return String(value || '').replace(/[._-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function appendSection(root, title, content) {
  if (content === null || content === undefined || content === '') return;
  const section = document.createElement('section');
  section.className = 'u2-why__section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.appendChild(heading);
  const body = document.createElement('div');
  body.className = 'u2-why__content';
  body.textContent = String(content);
  section.appendChild(body);
  root.appendChild(section);
}

function appendListSection(root, title, items) {
  if (!Array.isArray(items) || !items.length) return;
  const section = document.createElement('section');
  section.className = 'u2-why__section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.appendChild(heading);
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  section.appendChild(list);
  root.appendChild(section);
}

export class U2Why extends HTMLElement {
  static get observedAttributes() { return ['action-id', 'recommendation-id']; }

  set actionId(value) {
    if (value) this.setAttribute('action-id', value);
    else this.removeAttribute('action-id');
  }

  get actionId() { return this.getAttribute('action-id'); }

  set recommendationId(value) {
    if (value) this.setAttribute('recommendation-id', value);
    else this.removeAttribute('recommendation-id');
  }

  get recommendationId() { return this.getAttribute('recommendation-id'); }

  attributeChangedCallback() {
    this._explanation = null;
    this._render();
  }

  connectedCallback() { this._render(); }

  _render() {
    this.textContent = '';
    if (!this.actionId && !this.recommendationId) return;

    const details = document.createElement('details');
    details.className = 'u2-why';
    const summary = document.createElement('summary');
    summary.textContent = 'Why?';
    summary.setAttribute('aria-label', 'Explain why U2OS proposed or performed this action');
    details.appendChild(summary);

    const panel = document.createElement('div');
    panel.className = 'u2-why__panel';
    details.appendChild(panel);
    details.addEventListener('toggle', () => {
      if (details.open && !this._explanation && !this._loading) this._load(panel);
    });
    this.appendChild(details);
  }

  async _load(panel) {
    this._loading = true;
    panel.textContent = 'Loading explanation…';
    panel.setAttribute('role', 'status');
    try {
      const explanation = this.actionId
        ? await getActionExplanation(this.actionId)
        : await getRecommendationExplanation(this.recommendationId);
      this._explanation = explanation;
      this._renderExplanation(panel, explanation);
    } catch (err) {
      panel.className = 'u2-why__panel load-error';
      panel.textContent = `Couldn't load explanation: ${err.message}`;
    } finally {
      this._loading = false;
    }
  }

  _renderExplanation(panel, explanation) {
    panel.textContent = '';
    panel.removeAttribute('role');
    panel.className = 'u2-why__panel';

    const provenance = (explanation.contextProvenance || []).map((ref) =>
      `${humanize(ref.type)} ${ref.id}`
    );
    if (explanation.sourceEvent) {
      provenance.push(`${humanize(explanation.sourceEvent.type)}${explanation.sourceEvent.id ? ` ${explanation.sourceEvent.id}` : ''}`);
    }
    appendListSection(panel, 'What it noticed', provenance);
    appendSection(panel, 'Decision', explanation.reasoningSummary);

    const policy = [explanation.policyDomain, explanation.policyRule].filter(Boolean).join(' · ');
    appendSection(panel, 'Policy', policy);
    appendSection(panel, 'Model', explanation.model);
    appendSection(panel, 'Relevant dashboard', explanation.dashboardTitle);

    const trail = (explanation.relatedEvents || []).map((event) => {
      const when = event.timestamp ? ` · ${new Date(event.timestamp).toLocaleString()}` : '';
      return `${humanize(event.type)} · ${event.id}${when}`;
    });
    appendListSection(panel, 'Source trail', trail);

    if (!panel.children.length) panel.textContent = 'No explanation details are available.';
  }
}

customElements.define('u2-why', U2Why);
