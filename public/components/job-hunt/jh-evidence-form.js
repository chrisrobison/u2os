import { el, formatDay } from './jh-util.js';

// The inline question under an unverified item of the Match Analysis tab (#636). The question, its wording and its key come
// from the server (job.evidence.questions); this only draws a labelled Yes / No / Partly choice and an optional detail, and
// hands the answer to `onSave({ key, answer, detail })`, which resolves { ok: true } or { error }. The form stays as the
// owner left it when a save fails, and says why in a role=alert line.

export const MAX_DETAIL = 1000;
const CHOICES = [['yes', 'Yes, I can back this up'], ['no', 'No, this is a gap'], ['partly', 'Partly']];
let counter = 0;

/** The words for a stated answer, for the summary line and the provenance. */
export const answerWord = (answer) => ({ yes: 'Yes', no: 'No', partly: 'Partly' }[answer] ?? '—');

export function evidenceForm(question, { stated = null, onSave } = {}) {
  counter += 1;
  const id = `jh-ev-${counter}`;
  const status = el('p', { class: 'jh-detail__muted', role: 'status', 'data-evidence-part': 'status' });
  const form = el('form', { class: 'jh-evidence', 'data-evidence-form': question.key, novalidate: '' });
  const radios = CHOICES.map(([value, label]) => {
    const input = el('input', { type: 'radio', name: id, id: `${id}-${value}`, value, 'data-evidence-answer': value });
    if (stated?.answer === value) input.checked = true;
    return el('label', { class: 'jh-evidence__choice', for: `${id}-${value}` }, input, ` ${label}`);
  });
  const detail = el('textarea', { id: `${id}-detail`, class: 'jh-input', rows: '3', maxlength: String(MAX_DETAIL), 'data-evidence-detail': '' });
  if (stated?.detail) detail.value = stated.detail;
  const save = el('button', { type: 'submit', class: 'btn', 'data-evidence-save': '', text: 'Save and rescore' });
  form.append(
    el('fieldset', { class: 'jh-evidence__set' }, el('legend', { text: question.prompt }), ...radios),
    el('label', { for: `${id}-detail`, text: `Details (optional, up to ${MAX_DETAIL} characters)` }), detail,
    el('div', { class: 'jh-page__buttons' }, save), status);

  const say = (text, error = false) => { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); status.className = error ? 'load-error' : 'jh-detail__muted'; };
  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const picked = radios.map((label) => label.querySelector('input')).find((input) => input.checked);
    if (!picked) { say('Choose Yes, No or Partly.', true); radios[0].querySelector('input').focus?.(); return; }
    busy = true; save.disabled = true; say('Saving...');
    let outcome;
    try { outcome = await onSave?.({ key: question.key, answer: picked.getAttribute('value'), detail: detail.value.trim() }); } catch (error) { outcome = { error: error.message }; }
    busy = false; save.disabled = false;
    if (outcome?.error) say(`Could not save: ${outcome.error}`, true);
  });
  return form;
}

/** One line of provenance for something the owner stated: who said it, when, and where it is recorded. */
export function provenanceLine(stated) {
  return `${answerWord(stated.answer)}, stated by you on ${formatDay(stated.at)}. Recorded in ${stated.path} as ${stated.key}.`;
}
