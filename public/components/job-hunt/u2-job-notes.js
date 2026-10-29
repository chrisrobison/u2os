import * as api from '../../services/api.js';
import { el, formatStamp } from './jh-util.js';
import './jh-all.js';

// The Notes tab of the job detail panel (#634): one Markdown file per job in the vault (job-hunt/notes/<id>.md). The text
// is edited in a plain textarea and shown as text, never as HTML. Every load re-reads the file, so an edit made in a text
// editor appears here; a save carries the revision it was based on, and a file that changed meanwhile is a conflict the
// owner resolves by reloading. Documented in docs/job-hunt.md ("Job notes").

const DRAFT_KEY = (id) => `u2.jobNotes.draft.${id}`;
const readDraft = (id) => { try { return sessionStorage.getItem(DRAFT_KEY(id)); } catch { return null; } };
const writeDraft = (id, text) => { try { if (text == null) sessionStorage.removeItem(DRAFT_KEY(id)); else sessionStorage.setItem(DRAFT_KEY(id), text); } catch { /* not remembered */ } };

export class U2JobNotes extends HTMLElement {
  constructor() {
    super();
    this._id = null;
    this._note = null;
    this._seq = 0;
    this._state = 'idle'; // idle | loading | error | ready
    this._error = null;
    this._saving = false;
    this._conflict = null;
    this._message = null;
    this._text = '';
    this._draft = null;
  }

  /** The job whose note to show; loads it (re-reading the file). */
  set jobId(id) {
    if (id === this._id) return;
    this._id = id;
    this._note = null;
    this._conflict = null;
    this._message = null;
    this._text = '';
    if (this.isConnected) this.load();
  }

  get jobId() { return this._id; }
  get dirty() { return Boolean(this._note) && this._text.trim() !== (this._note.body ?? ''); }

  connectedCallback() {
    this.classList.add('jh-notes');
    if (this._id && !this._note && this._state !== 'loading') this.load(); else this._render(); // re-parenting keeps the text and any save in flight
  }

  async load() {
    const id = this._id;
    if (!id) { this._state = 'idle'; this._render(); return; }
    const seq = ++this._seq;
    this._state = 'loading';
    this._error = null;
    this._render();
    try {
      const note = await api.getJobHuntNotes(id);
      if (seq !== this._seq || id !== this._id) return;
      this._adopt(note);
    } catch (error) {
      if (seq !== this._seq) return;
      this._state = 'error';
      this._error = error.message;
    }
    this._render();
  }

  _adopt(note) {
    this._note = note;
    this._text = note.body ?? '';
    this._conflict = null;
    this._state = 'ready';
    const draft = readDraft(note.jobId);
    this._draft = draft != null && draft !== this._text ? draft : null;
    if (draft != null && draft === this._text) writeDraft(note.jobId, null);
  }

  /**
   * Saves unsaved text before the panel moves to another job. Returns true when nothing is left unsaved. When the save fails
   * (the file changed elsewhere, say) the text is kept in sessionStorage so the owner can restore it from this tab later.
   */
  async flush() {
    if (!this.dirty) return true;
    const id = this._id;
    const text = this._text;
    const ok = await this._save();
    if (!ok) writeDraft(id, text);
    return ok;
  }

  async _save() {
    if (!this._note || this._saving) return false;
    const id = this._id;
    const seq = this._seq;
    this._saving = true;
    this._message = { text: 'Saving...' };
    this._render();
    let ok = false;
    try {
      const note = await api.saveJobHuntNotes(id, this._text, this._note.revision);
      if (seq === this._seq && id === this._id) {
        this._note = note;
        this._conflict = null;
        this._message = { text: note.exists ? `Saved ${formatStamp(note.updatedAt)}` : 'Nothing to save yet.' };
        writeDraft(id, null);
      }
      ok = true;
    } catch (error) {
      if (seq === this._seq && id === this._id) {
        if (error.status === 409 && error.code === 'CONFLICT') { this._conflict = error.body?.note ?? null; this._message = null; } else this._message = { error: true, text: error.message };
      }
    }
    this._saving = false;
    if (seq === this._seq) this._render();
    return ok;
  }

  _reloadFromFile() {
    const fresh = this._conflict;
    if (fresh) { this._adopt(fresh); this._message = { text: 'Reloaded from the file.' }; this._render(); } else this.load();
  }

  _render() {
    const focus = typeof document !== 'undefined' && this.contains?.(document.activeElement) ? document.activeElement?.getAttribute?.('data-notes-part') : null;
    const caret = focus === 'text' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    if (this._state === 'loading' || (this._state === 'idle' && this._id)) { this.replaceChildren(el('jh-state', { kind: 'loading', title: 'Opening notes...' })); return; }
    if (this._state === 'error') {
      const retry = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'retry', text: 'Try again' });
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(el('jh-state', { kind: 'error', title: "Couldn't open the notes", message: this._error }), retry);
      return;
    }
    if (!this._note) { this.replaceChildren(); return; }
    const note = this._note;
    const area = el('textarea', { class: 'jh-input jh-notes__area', id: 'jh-notes-text', rows: '12', 'data-notes-part': 'text', spellcheck: 'true', 'aria-describedby': 'jh-notes-hint' });
    area.value = this._text;
    area.addEventListener('input', () => { this._text = area.value; this._updateControls(); });
    const save = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'save', text: this._saving ? 'Saving...' : 'Save notes' });
    save.addEventListener('click', () => this._save());
    this._saveButton = save;
    const parts = [
      el('label', { class: 'jh-notes__label', for: 'jh-notes-text', text: 'Notes (Markdown)' }),
      area,
      el('p', { class: 'jh-detail__muted', id: 'jh-notes-hint', text: `Saved as ${note.path} in your vault, so you can also edit it in any text editor. Up to ${Math.round(note.maxBytes / 1024)} KB.` }),
      el('div', { class: 'jh-page__buttons' }, save),
    ];
    if (this._conflict) {
      const reload = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'reload', text: 'Reload from file' });
      reload.addEventListener('click', () => this._reloadFromFile());
      const keep = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'keep', text: 'Keep editing' });
      keep.addEventListener('click', () => { this._conflict = null; this._render(); });
      parts.push(el('div', { class: 'jh-notes__conflict', role: 'alert', 'data-notes-part': 'conflict' },
        el('strong', { text: 'This note changed since you opened it.' }),
        el('p', { text: 'Someone or something (an editor, another tab) saved the file. Your text was not saved. Reload to see the file as it is now; your unsaved text is replaced. Or keep editing and copy what you need first.' }),
        el('div', { class: 'jh-page__buttons' }, reload, keep)));
    }
    if (this._draft != null) {
      const restore = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'restore', text: 'Restore it' });
      restore.addEventListener('click', () => { this._text = this._draft; this._draft = null; this._render(); });
      const discard = el('button', { type: 'button', class: 'btn', 'data-notes-part': 'discard', text: 'Discard it' });
      discard.addEventListener('click', () => { writeDraft(this._id, null); this._draft = null; this._render(); });
      parts.push(el('div', { class: 'jh-notes__draft', role: 'status', 'data-notes-part': 'draft' }, el('span', { text: 'Text you had not saved earlier is still here, because the note changed in the meantime.' }), restore, discard));
    }
    if (this._message) parts.push(el('p', { class: this._message.error ? 'load-error' : 'jh-page__ok', role: this._message.error ? 'alert' : 'status', 'data-notes-part': 'message', text: this._message.text }));
    this.replaceChildren(...parts);
    this._updateControls();
    if (focus) {
      const target = this.querySelector(`[data-notes-part="${focus}"]`);
      target?.focus?.();
      if (caret && target?.setSelectionRange) { try { target.setSelectionRange(caret[0], caret[1]); } catch { /* not a text control */ } }
    }
  }

  _updateControls() {
    if (!this._saveButton) return;
    this._saveButton.disabled = this._saving || !this.dirty;
  }
}

if (!customElements.get('u2-job-notes')) customElements.define('u2-job-notes', U2JobNotes);
