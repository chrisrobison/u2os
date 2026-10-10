import { el, monogram, fitChip, fitBand, FIT_BANDS, relTime } from './jh-util.js';

// The application pipeline: one column per stage (or per fit band), a card per
// job. Selecting a card dispatches `jh-select` with the job id. Search and
// group-by are client-side over the cards the dashboard API returned.

const GROUPINGS = [['stage', 'Stage'], ['fit', 'Fit']];
const STAGE_TONES = { saved: 'neutral', applied: 'active', screening: 'pending', interviewing: 'strong', offer: 'active', rejected: 'danger' };
const FIT_TONES = { high: 'active', good: 'pending', low: 'neutral', none: 'neutral' };

const haystack = (job) => [job.company, job.role, job.location, job.statusLine].filter(Boolean).join(' ').toLowerCase();

export class U2JobPipeline extends HTMLElement {
  constructor() {
    super();
    this._stages = [];
    this._query = '';
    this._groupBy = 'stage';
    this._selectedId = null;
    this._built = false;
  }

  connectedCallback() {
    if (!this._built) this._build();
    this._render();
  }

  _build() {
    this._built = true;
    this.classList.add('jh-panel', 'jh-pipeline');
    const titleId = 'jh-pipeline-title';
    this.setAttribute('aria-labelledby', titleId);
    this.setAttribute('role', 'region');
    this._total = el('span', { class: 'jh-pipeline__total', 'aria-live': 'polite' });
    const select = el('select', { id: 'jh-groupby', class: 'jh-select' }, GROUPINGS.map(([value, label]) => el('option', { value, text: label })));
    select.addEventListener('change', () => { this._groupBy = select.value; this._render(); });
    this._note = el('p', { class: 'jh-note', hidden: true });
    this._board = el('div', { class: 'jh-board', tabindex: '0', role: 'region', 'aria-label': 'Pipeline board' });
    this.append(
      el('div', { class: 'jh-panel__head' },
        el('div', { class: 'jh-panel__titles' }, el('h2', { id: titleId, class: 'jh-panel__title', text: 'Application Pipeline' }), this._total),
        el('div', { class: 'jh-groupby' }, el('label', { for: 'jh-groupby', text: 'Group by' }), select)),
      this._note,
      this._board,
    );
  }

  update({ stages, selectedId }) {
    this._stages = stages || [];
    this._selectedId = selectedId ?? null;
    if (this._built) this._render();
  }

  setSelected(id) {
    this._selectedId = id;
    if (!this._built) return;
    for (const card of this._board.querySelectorAll('.jh-card')) card.setAttribute('aria-pressed', String(card.dataset.id === id));
  }

  setQuery(query) {
    this._query = String(query || '').trim().toLowerCase();
    if (this._built) this._render();
  }

  _groups() {
    if (this._groupBy === 'fit') {
      const all = this._stages.flatMap((stage) => stage.jobs).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
      return FIT_BANDS.map(({ id, label }) => ({ id, label, tone: FIT_TONES[id], jobs: all.filter((job) => fitBand(job.fit) === id) }));
    }
    return this._stages.map((stage) => ({ id: stage.id, label: stage.label, tone: STAGE_TONES[stage.id] || 'neutral', jobs: stage.jobs }));
  }

  _card(job) {
    const when = relTime(job.timestamp);
    const button = el('button', { type: 'button', class: 'jh-card', 'data-id': job.id, 'aria-pressed': String(job.id === this._selectedId) },
      el('span', { class: 'jh-card__top' }, monogram(job.company),
        el('span', { class: 'jh-card__who' },
          el('span', { class: 'jh-card__company', text: job.company }),
          el('span', { class: 'jh-card__role', text: job.role || '(no role stated)' }),
          job.location ? el('span', { class: 'jh-card__loc', text: job.location }) : null)),
      el('span', { class: 'jh-card__foot' }, fitChip(job.fit), el('span', { class: 'jh-card__meta', text: [job.statusLine, when].filter(Boolean).join(' · ') })));
    button.addEventListener('click', () => this.dispatchEvent(new CustomEvent('jh-select', { bubbles: true, detail: { id: job.id } })));
    return el('li', { class: 'jh-board__item' }, button);
  }

  _render() {
    const groups = this._groups();
    const total = this._stages.reduce((n, stage) => n + stage.count, 0);
    const shownAll = groups.reduce((n, group) => n + group.jobs.length, 0);
    const matches = groups.map((group) => ({ ...group, jobs: this._query ? group.jobs.filter((job) => haystack(job).includes(this._query)) : group.jobs }));
    const matched = matches.reduce((n, group) => n + group.jobs.length, 0);

    this._total.textContent = this._query ? `${matched} of ${total} jobs match` : `${total} job${total === 1 ? '' : 's'} total`;
    this._note.hidden = shownAll >= total;
    this._note.textContent = shownAll < total ? `Showing the newest ${shownAll} of ${total} jobs.` : '';

    // The board is rebuilt on every refresh; keep the reader's place in it.
    const scroll = this._board.scrollLeft;
    const focusedId = this._board.contains(document.activeElement) ? document.activeElement.dataset?.id : null;

    this._board.textContent = '';
    if (!total) {
      this._board.append(el('div', { class: 'jh-empty jh-empty--board' },
        el('p', { class: 'jh-empty__title', text: 'No jobs in your pipeline yet.' }),
        el('p', { text: 'Run npm run u2 -- job discover hn, then job score. Jobs that qualify show up under Saved, and the pipeline fills as applications are sent and answered.' })));
    } else {
      for (const group of matches) {
        const headId = `jh-col-${this._groupBy}-${group.id}`;
        this._board.append(el('section', { class: `jh-col jh-col--${group.tone}`, 'aria-labelledby': headId },
          el('h3', { class: 'jh-col__head', id: headId },
            el('span', { class: 'jh-col__dot', 'aria-hidden': 'true' }), el('span', { class: 'jh-col__label', text: group.label }),
            el('span', { class: 'jh-col__count', text: String(group.jobs.length) })),
          group.jobs.length
            ? el('ul', { class: 'jh-col__list' }, group.jobs.map((job) => this._card(job)))
            : el('p', { class: 'jh-col__empty', text: this._query ? 'No matches' : 'Nothing here yet' })));
      }
    }
    this._board.scrollLeft = scroll;
    if (focusedId) this._board.querySelector(`.jh-card[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }
}

customElements.define('u2-job-pipeline', U2JobPipeline);
