import { buildForm, readForm, showErrors } from './record-form.js';

let modalCounter = 0;

// Shared record dialog (#434), built on the native <dialog> element so focus
// trapping, inertness of the page behind it and Escape come from the browser.
//
//   const modal = document.createElement('u2-modal');
//   document.body.append(modal);
//   modal.open({
//     title: 'New task',
//     fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
//     values: {},                         // empty for "+", populated for a row
//     submitLabel: 'Create',
//     onSubmit: async (values) => { ... },   // throw to show the error inline
//     actions: [{ label: 'Mark complete', onClick: async () => { ... } }],
//     validate: (values) => ({ end: 'End must be after start.' }),  // optional, cross-field
//     (an action with href renders as a link that opens in a new tab)
//     opener: buttonElement,               // gets focus back on close
//   });
//
// Closing with unsaved edits asks for confirmation. Focus returns to the
// element that opened the dialog.
export class U2Modal extends HTMLElement {
  connectedCallback() {
    if (this._dialog) return;
    this._id = `u2-modal-${++modalCounter}`;
    this._dialog = document.createElement('dialog');
    this._dialog.className = 'u2-modal';
    this._dialog.setAttribute('aria-labelledby', `${this._id}-heading`);
    this.append(this._dialog);

    // Escape and the backdrop go through the same dirty check as Cancel.
    this._dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this._requestClose();
    });
    this._dialog.addEventListener('mousedown', (event) => {
      if (event.target === this._dialog) this._requestClose();
    });
    this._dialog.addEventListener('close', () => {
      this._restoreFocus();
      this.dispatchEvent(new CustomEvent('u2-modal-closed', { bubbles: true }));
    });
  }

  get isOpen() {
    return Boolean(this._dialog && this._dialog.open);
  }

  open({ title, fields = [], values = {}, submitLabel = 'Save', cancelLabel = 'Cancel', onSubmit = null, actions = [], notice = '', opener = null, validate = null }) {
    if (!this._dialog) this.connectedCallback();
    if (this._dialog.open) this._dialog.close();
    // Safari does not focus a button when it is clicked, so callers pass the
    // element that opened the dialog; activeElement is only the fallback.
    this._opener = opener || document.activeElement;
    this._fields = fields;
    this._onSubmit = onSubmit;
    this._validate = validate;
    this._dirty = false;
    this._busy = false;

    this._dialog.textContent = '';
    const heading = document.createElement('h2');
    heading.id = `${this._id}-heading`;
    heading.className = 'u2-modal__title';
    heading.textContent = title;
    this._dialog.append(heading);

    if (notice) {
      const note = document.createElement('p');
      note.className = 'u2-modal__notice';
      note.textContent = notice;
      this._dialog.append(note);
    }

    this._form = buildForm(fields, values, { idPrefix: this._id });
    this._form.addEventListener('input', () => { this._dirty = true; });
    this._form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._submit();
    });
    this._dialog.append(this._form);

    this._status = document.createElement('div');
    this._status.className = 'u2-modal__status load-error';
    this._status.setAttribute('role', 'alert');
    this._status.hidden = true;
    this._dialog.append(this._status);

    const footer = document.createElement('div');
    footer.className = 'u2-modal__footer';
    for (const action of actions) {
      if (action.href) {
        // A link, not a button: it hands off to another app (for example a
        // Gmail reply) and runs no U2OS action.
        const link = document.createElement('a');
        link.className = `btn${action.primary ? ' btn-primary' : ''}`;
        link.href = action.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = action.label;
        footer.append(link);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn${action.danger ? ' btn-danger' : ''}`;
      btn.textContent = action.label;
      btn.addEventListener('click', () => this._runAction(action, btn));
      footer.append(btn);
    }
    const spacer = document.createElement('span');
    spacer.className = 'u2-modal__spacer';
    footer.append(spacer);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = cancelLabel;
    cancel.addEventListener('click', () => this._requestClose());
    footer.append(cancel);

    if (onSubmit) {
      this._submitBtn = document.createElement('button');
      this._submitBtn.type = 'submit';
      this._submitBtn.className = 'btn btn-primary';
      this._submitBtn.textContent = submitLabel;
      // Associate by id so the button works from the footer, outside <form>.
      this._form.id = `${this._id}-form`;
      this._submitBtn.setAttribute('form', this._form.id);
      footer.append(this._submitBtn);
    }
    this._dialog.append(footer);

    this._dialog.showModal();
    const first = this._form.querySelector('input:not([readonly]):not([disabled]), textarea:not([readonly]), select:not([disabled])');
    (first || cancel).focus();
  }

  close() {
    if (this._dialog && this._dialog.open) this._dialog.close();
  }

  _requestClose() {
    if (this._busy) return;
    if (this._dirty && !window.confirm('Discard your changes?')) return;
    this.close();
  }

  _restoreFocus() {
    const target = this._opener;
    this._opener = null;
    if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
    else document.getElementById('workspace')?.focus();
  }

  _setBusy(busy) {
    this._busy = busy;
    for (const btn of this._dialog.querySelectorAll('.u2-modal__footer button')) btn.disabled = busy;
  }

  _showStatus(message) {
    this._status.textContent = message || '';
    this._status.hidden = !message;
  }

  async _submit() {
    if (this._busy || !this._onSubmit) return;
    this._showStatus('');
    const { values, errors } = readForm(this._form, this._fields);
    if (showErrors(this._form, errors)) return;
    // Rules that span fields, such as "end is after start".
    const crossErrors = this._validate ? this._validate(values) : null;
    if (crossErrors && showErrors(this._form, crossErrors)) return;
    this._setBusy(true);
    try {
      await this._onSubmit(values);
      this._dirty = false;
      this._setBusy(false);
      this.close();
    } catch (err) {
      this._setBusy(false);
      this._showStatus(err && err.message ? err.message : 'Something went wrong.');
    }
  }

  async _runAction(action, button) {
    if (this._busy) return;
    this._showStatus('');
    this._setBusy(true);
    try {
      await action.onClick();
      this._dirty = false;
      this._setBusy(false);
      this.close();
    } catch (err) {
      this._setBusy(false);
      this._showStatus(err && err.message ? err.message : 'Something went wrong.');
      button.focus();
    }
  }
}

customElements.define('u2-modal', U2Modal);

// One shared dialog per page; sections call this instead of managing their
// own element.
export function getModal() {
  let modal = document.querySelector('u2-modal');
  if (!modal) {
    modal = document.createElement('u2-modal');
    document.body.append(modal);
  }
  return modal;
}
