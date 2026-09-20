import { getRecommendation, updateRecommendation } from '../services/api.js';
import './u2-why.js';

export class U2Recommendation extends HTMLElement {
  set recommendationId(value) { this._recommendationId = value; this._load(); }
  get recommendationId() { return this._recommendationId; }
  set recommendation(value) { this._recommendation = value; this._render(); }
  get recommendation() { return this._recommendation; }
  connectedCallback() { this._recommendation ? this._render() : this._load(); }

  async _load() {
    if (!this.isConnected || !this._recommendationId || this._loading) return;
    this._loading = true;
    this.textContent = 'Loading recommendation…';
    try {
      this._recommendation = await getRecommendation(this._recommendationId);
      this._render();
    } catch (err) {
      this.className = 'load-error';
      this.textContent = `Couldn't load recommendation: ${err.message}`;
    } finally {
      this._loading = false;
    }
  }

  _render() {
    const recommendation = this._recommendation;
    if (!recommendation) return;
    this.textContent = '';
    this.className = 'u2-recommendation';

    const title = document.createElement('div');
    title.className = 'u2-recommendation__title';
    title.textContent = recommendation.decision === 'prepare' ? 'Prepared for you' : 'Suggestion';
    this.appendChild(title);

    if (recommendation.reasoning_summary) {
      const reason = document.createElement('div');
      reason.className = 'u2-recommendation__reason';
      reason.textContent = recommendation.reasoning_summary;
      this.appendChild(reason);
    }

    const why = document.createElement('u2-why');
    why.recommendationId = recommendation.id;
    this.appendChild(why);

    if (recommendation.dashboard) {
      const dashboard = document.createElement('u2-dashboard');
      dashboard.schema = recommendation.dashboard;
      this.appendChild(dashboard);
    }

    if (recommendation.status === 'open') {
      const actions = document.createElement('div');
      actions.className = 'u2-recommendation__actions';
      actions.append(this._button('Dismiss', 'dismissed'), this._button('Keep', 'accepted'));
      this.appendChild(actions);
    }
  }

  _button(label, status) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = status === 'accepted' ? 'btn btn-primary' : 'btn btn-ghost';
    button.textContent = label;
    button.addEventListener('click', async () => {
      button.parentElement.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      try {
        this._recommendation = await updateRecommendation(this._recommendation.id, status);
        this._render();
      } catch (err) {
        const error = document.createElement('div');
        error.className = 'load-error';
        error.textContent = `Couldn't update recommendation: ${err.message}`;
        this.appendChild(error);
        button.parentElement?.querySelectorAll('button').forEach((item) => { item.disabled = false; });
      }
    });
    return button;
  }
}

customElements.define('u2-recommendation', U2Recommendation);
