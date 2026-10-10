import { el, svg, formatDay } from './jh-util.js';

// Resume and cover-letter versions: each distinct file the pipeline produced,
// with the jobs it went to. Read-only; the files live in the vault.

const KINDS = { resume_pdf: 'Resume', cover_letter_pdf: 'Cover letter' };

function docIcon() {
  return svg('svg', { class: 'jh-doc', viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: 'M6 2h8l5 5v15H6z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }),
    svg('path', { d: 'M9 12h7M9 16h7', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
}

export class U2JobResumes extends HTMLElement {
  constructor() { super(); this._built = false; this._versions = null; }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.classList.add('jh-panel');
      this.setAttribute('role', 'region');
      this.setAttribute('aria-labelledby', 'jh-resumes-title');
      this._body = el('div');
      this.append(el('div', { class: 'jh-panel__head' }, el('h2', { id: 'jh-resumes-title', class: 'jh-panel__title', text: 'Resume & Cover Letter Versions' })), this._body);
    }
    this._render();
  }

  update(versions) {
    this._versions = versions;
    if (this._built) this._render();
  }

  _render() {
    this._body.textContent = '';
    if (!this._versions) return;
    if (!this._versions.length) {
      this._body.append(el('p', { class: 'jh-empty', text: 'No resumes or cover letters yet. They are listed here once materials are generated for a job.' }));
      return;
    }
    this._body.append(el('ul', { class: 'jh-versions' }, this._versions.map((version) => {
      const names = version.usedBy.map((job) => job.company || 'Unknown company');
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
      return el('li', { class: 'jh-version' }, docIcon(),
        el('div', { class: 'jh-version__body' },
          el('div', { class: 'jh-version__name' }, el('span', { text: version.file }), el('span', { class: 'jh-tag', text: KINDS[version.kind] || version.kind })),
          el('div', { class: 'jh-version__meta', text: `Used for ${version.usedBy.length} job${version.usedBy.length === 1 ? '' : 's'}: ${shown}` })),
        el('time', { class: 'jh-version__date', datetime: version.updatedAt, text: formatDay(version.updatedAt) }));
    })));
  }
}

customElements.define('u2-job-resumes', U2JobResumes);
