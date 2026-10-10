import { el, svg, monogram, safeUrl, titleCase } from './jh-util.js';

// Upcoming Interviews: dated rows for the next 30 days, from the dashboard's
// `interviews`. Read-only here; interviews are added from a job's details.
// There is no "View Calendar" link: interviews live in the hunt store, not in
// the calendar, so there is nowhere real for it to go.

const KIND_LABELS = { phone: 'Phone call', video: 'Video call', onsite: 'Onsite', other: 'Interview' };

function icon(kind) {
  const paths = {
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z',
    onsite: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    video: 'M3 7h11v10H3zM14 11l7-4v10l-7-4',
  };
  return svg('svg', { class: 'jh-ico', viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: paths[kind] || paths.video, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "10:00 AM – 11:00 AM", or just the start when no end was given. */
export function timeRange(interview) {
  return interview.endsAt ? `${time(interview.at)} – ${time(interview.endsAt)}` : time(interview.at);
}

export class U2JobInterviews extends HTMLElement {
  constructor() { super(); this._built = false; this._items = null; }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.classList.add('jh-panel');
      this.setAttribute('role', 'region');
      this.setAttribute('aria-labelledby', 'jh-interviews-title');
      this._body = el('div');
      this.append(el('div', { class: 'jh-panel__head' }, el('h2', { id: 'jh-interviews-title', class: 'jh-panel__title', text: 'Upcoming Interviews' })), this._body);
    }
    this._render();
  }

  update(items) {
    this._items = items;
    if (this._built) this._render();
  }

  _render() {
    this._body.textContent = '';
    if (!this._items) return;
    if (!this._items.length) {
      this._body.append(el('p', { class: 'jh-empty', text: 'No interviews in the next 30 days. Add one from a job’s details.' }));
      return;
    }
    this._body.append(el('ul', { class: 'jh-interviews' }, this._items.map((item) => this._row(item))));
  }

  _row(item) {
    const day = new Date(item.at);
    const link = safeUrl(item.locationOrLink);
    const where = item.locationOrLink && !link ? item.locationOrLink : null;
    const company = el('button', { type: 'button', class: 'jh-linkbtn', text: item.company });
    company.addEventListener('click', () => this.dispatchEvent(new CustomEvent('jh-select', { bubbles: true, detail: { id: item.jobId } })));
    return el('li', { class: 'jh-interview' },
      el('time', { class: 'jh-daybox', datetime: item.at },
        el('span', { class: 'sr-only', text: day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) }),
        el('span', { class: 'jh-daybox__month', 'aria-hidden': 'true', text: day.toLocaleDateString(undefined, { month: 'short' }) }),
        el('span', { class: 'jh-daybox__day', 'aria-hidden': 'true', text: String(day.getDate()) })),
      monogram(item.company),
      el('div', { class: 'jh-interview__who' }, company,
        el('div', { class: 'jh-interview__role', text: [item.role, item.round].filter(Boolean).join(' · ') })),
      el('div', { class: 'jh-interview__when' },
        el('div', { text: timeRange(item) }),
        el('div', { class: 'jh-interview__kind' }, icon(item.kind), el('span', { text: KIND_LABELS[item.kind] || titleCase(item.kind) }),
          link ? el('a', { class: 'jh-link', href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Join link ↗' }) : null,
          where ? el('span', { class: 'jh-interview__where', text: where }) : null)));
  }
}

customElements.define('u2-job-interviews', U2JobInterviews);
