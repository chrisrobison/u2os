import * as api from '../../services/api.js';
import { contactForm, plainEmail, ROLE_KINDS } from './jh-forms.js';
import { el, svg, monogram, relTime } from './jh-util.js';

// Networking & Contacts: people per job from the dashboard's `contacts` (most
// recently contacted first). Row: monogram, name, title and company, a role
// chip, "Last contact 3d ago" and actions. The mail action is a mailto: link:
// it opens the owner's own mail client, and U2OS sends nothing from here (the
// gated send path is bound to a job's application email, not to an ad hoc
// contact). All text is set with textContent.

const ROLE_LABELS = Object.fromEntries(ROLE_KINDS);
ROLE_LABELS.other = 'Contact';

/** mailto: for a contact, or null when the address is not one plain address. The subject is one line. */
export function mailtoHref(contact) {
  if (!plainEmail(contact.email)) return null;
  const subject = `Re: ${[contact.role, contact.company].filter(Boolean).join(' at ')}`.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
  return `mailto:${encodeURIComponent(contact.email)}?subject=${encodeURIComponent(subject)}`;
}

function mailIcon() {
  return svg('svg', { class: 'jh-ico', viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    svg('path', { d: 'M3.5 6.5l8.5 6.5 8.5-6.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

export class U2JobContacts extends HTMLElement {
  constructor() { super(); this._built = false; this._items = null; this._jobs = []; this._busy = new Set(); this._form = null; }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.classList.add('jh-panel');
      this.setAttribute('role', 'region');
      this.setAttribute('aria-labelledby', 'jh-contacts-title');
      this._add = el('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', 'aria-controls': 'jh-contacts-form', text: 'Add contact' });
      this._add.addEventListener('click', () => (this._form ? this._closeForm() : this._openForm(null)));
      this._alert = el('p', { class: 'load-error', role: 'alert', hidden: true });
      this._body = el('div');
      // The form lives outside the re-rendered list so a refresh never wipes what is being typed.
      this._formHost = el('div', { class: 'jh-formhost', id: 'jh-contacts-form' });
      this.append(el('div', { class: 'jh-panel__head' }, el('h2', { id: 'jh-contacts-title', class: 'jh-panel__title', text: 'Networking & Contacts' }), this._add), this._alert, this._body, this._formHost);
    }
    this._render();
  }

  /** `jobs` are the pipeline's cards ({id, company, role}), for the add form's job choice. */
  update(items, jobs = []) {
    this._items = items;
    this._jobs = jobs;
    if (this._built) this._render();
  }

  tick() { if (this._built && this._items) this._render(); }

  _render() {
    if (!this._items) return;
    const focused = this._body.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
    this._body.textContent = '';
    if (!this._items.length) {
      this._body.append(el('p', { class: 'jh-empty', text: 'No contacts yet. Recruiters from listings and people you have emailed appear here; add your own with Add contact.' }));
      return;
    }
    this._body.append(el('ul', { class: 'jh-contacts' }, this._items.map((item) => this._row(item))));
    if (focused) this._body.querySelector(`[data-focus-key="${focused}"]`)?.focus();
  }

  _row(item) {
    const busy = this._busy.has(item.id);
    const href = mailtoHref(item);
    const mail = href
      ? el('a', { class: 'jh-iconbtn', href, 'aria-label': `Email ${item.name}`, title: `Email ${item.name}`, 'data-focus-key': `mail-${item.id}` }, mailIcon())
      : null;
    const button = (label, key, aria, run) => {
      const node = el('button', { type: 'button', class: 'jh-mini', 'data-focus-key': `${key}-${item.id}`, 'aria-label': `${aria} ${item.name}`, disabled: busy, text: label });
      node.addEventListener('click', run);
      return node;
    };
    const last = item.lastContactAt ? `Last contact ${relTime(item.lastContactAt)}` : 'Not contacted yet';
    return el('li', { class: 'jh-contact' },
      monogram(item.name),
      el('div', { class: 'jh-contact__who' },
        el('div', { class: 'jh-contact__name', text: item.name }),
        el('div', { class: 'jh-contact__sub', text: [item.title, item.company].filter(Boolean).join(' · ') })),
      el('div', { class: 'jh-contact__side' },
        el('span', { class: `jh-role jh-role--${item.roleKind}`, text: ROLE_LABELS[item.roleKind] || ROLE_LABELS.other }),
        el('span', { class: 'jh-contact__last', text: last })),
      el('div', { class: 'jh-contact__actions' },
        mail,
        button('Contacted', 'contacted', 'Mark contacted today:', () => this._mutate(item, () => api.markJobHuntContacted(item.id))),
        button('Edit', 'edit', 'Edit', () => this._openForm(item)),
        button('Remove', 'remove', 'Remove', () => this._mutate(item, () => api.deleteJobHuntContact(item.id)))));
  }

  _closeForm() {
    this._form = null;
    this._formHost.textContent = '';
    this._add.setAttribute('aria-expanded', 'false');
  }

  _openForm(contact) {
    this._closeForm();
    this._form = contact ? contact.id : 'new';
    this._add.setAttribute('aria-expanded', String(!contact));
    const onCancel = () => { this._closeForm(); (contact ? this._body.querySelector(`[data-focus-key="edit-${contact.id}"]`) : this._add)?.focus(); };
    const done = () => { this._closeForm(); this.dispatchEvent(new CustomEvent('jh-changed', { bubbles: true })); };
    const form = contactForm({
      jobs: this._jobs, contact, onCancel,
      async onSubmit(body, fail) {
        try {
          if (contact) await api.updateJobHuntContact(contact.id, body);
          else { const { jobId, ...rest } = body; await api.addJobHuntContact(jobId, rest); }
          done();
        } catch (err) { fail(err.message); }
      },
    });
    this._formHost.append(form);
    form.querySelector('input, select')?.focus();
  }

  async _mutate(item, run) {
    this._busy.add(item.id);
    this._alert.hidden = true;
    this._render();
    try {
      await run();
      this.dispatchEvent(new CustomEvent('jh-changed', { bubbles: true, detail: { id: item.jobId } }));
    } catch (err) {
      this._alert.hidden = false;
      this._alert.textContent = `Couldn't update the contact: ${err.message}`;
    }
    this._busy.delete(item.id);
    this._render();
  }
}

customElements.define('u2-job-contacts', U2JobContacts);
