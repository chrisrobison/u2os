import * as api from '../../services/api.js';
import { el } from './jh-util.js';

// The unanswered questions of a job's latest application plan, as inputs the
// owner fills in, and the modal that asks for them. Answers are saved to the
// owner's answers.yaml by POST /api/job-hunt/jobs/:id/answers, so they are
// reused for every later application, and the form is planned again.

/** The questions the owner can answer here: the keyed ones. Sensitive ones are never answered for the owner. */
export const answerableQuestions = (job) => (job?.applications?.[0]?.plan?.unresolved ?? []).filter((question) => question.key);
export const sensitiveQuestions = (job) => (job?.applications?.[0]?.plan?.unresolved ?? []).filter((question) => !question.key);

/** One labelled input per question (choice questions offer the form's own options). Returns the nodes and a reader. */
export function buildAnswerInputs(questions, idPrefix = 'jh-answer') {
  const inputs = new Map();
  const rows = questions.map((question, index) => {
    const id = `${idPrefix}-${index}`;
    const choices = question.options?.length ? question.options : question.type === 'checkbox' ? ['Yes'] : null;
    let input;
    if (choices) input = el('select', { id, class: 'jh-input' }, el('option', { value: '', text: 'Choose...' }), choices.map((choice) => el('option', { value: choice, text: choice })));
    else if (question.type === 'textarea' || String(question.label).length > 120) input = el('textarea', { id, class: 'jh-input', rows: '3', maxlength: '2000' });
    else input = el('input', { id, class: 'jh-input', type: 'text', maxlength: '2000' });
    inputs.set(question.key, input);
    return el('div', { class: 'jh-page__answer', 'data-key': question.key }, el('label', { for: id, text: `${question.label}${question.required ? ' *' : ''}` }), input);
  });
  const read = () => [...inputs].map(([key, input]) => ({ key, value: input.value.trim() })).filter((answer) => answer.value);
  return { rows, read };
}

export const savedMessage = (result) => result.replanError
  ? { error: true, text: `Saved ${result.saved} answer${result.saved === 1 ? '' : 's'}, but the form could not be read again: ${result.replanError}` }
  : { text: result.unresolved ? `Saved. ${result.unresolved} question${result.unresolved === 1 ? ' is' : 's are'} still unanswered.` : 'Saved. Every question is answered and the application is planned again.' };

/** The Answer Questions modal. `onSaved(job)` gets the refreshed job. Resolves when the dialog closes. */
export function openAnswersDialog(job, { onSaved, opener = null } = {}) {
  const questions = answerableQuestions(job);
  const sensitive = sensitiveQuestions(job);
  const title = el('h2', { id: 'jh-answers-title', class: 'jh-approve-dialog__title', text: `Answer questions: ${job.role || 'this role'} at ${job.company}` });
  const close = el('button', { type: 'button', class: 'btn', text: 'Close' });
  const status = el('p', { role: 'status', class: 'jh-page__ok', hidden: '' });
  const dialog = el('dialog', { class: 'jh-approve-dialog', 'aria-labelledby': 'jh-answers-title', 'data-answers-dialog': '' }, el('div', { class: 'jh-approve-dialog__head' }, title, close));
  let busy = false;
  const show = (notice) => { status.hidden = !notice; status.textContent = notice?.text ?? ''; status.className = notice?.error ? 'load-error' : 'jh-page__ok'; status.setAttribute('role', notice?.error ? 'alert' : 'status'); };

  if (!questions.length) {
    dialog.append(el('p', { class: 'jh-empty', text: 'Nothing is waiting for an answer on this job.' }));
  } else {
    const { rows, read } = buildAnswerInputs(questions, 'jh-dlg-answer');
    const form = el('form', { class: 'jh-page__answers', 'data-answer-dialog-form': '' },
      el('p', { text: 'Your answers are saved to job-hunt/answers.yaml and reused for every later application. Leave a question blank to skip it.' }), rows);
    const save = el('button', { type: 'submit', class: 'btn', text: 'Save answers and re-plan' });
    form.append(el('div', { class: 'jh-page__buttons' }, save), status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const answers = read();
      if (!answers.length) { show({ error: true, text: 'Type or choose at least one answer.' }); return; }
      busy = true; save.disabled = true; show({ text: 'Saving, then reading the form again...' });
      try {
        const result = await api.answerJobHuntQuestions(job.id, answers);
        show(savedMessage(result));
        onSaved?.(result.job);
        if (!result.unresolved && !result.replanError) setTimeout(() => dialog.close(), 900);
      } catch (error) {
        show({ error: true, text: error.message });
      }
      busy = false; save.disabled = false;
    });
    dialog.append(form);
  }
  if (sensitive.length) {
    dialog.append(el('div', { class: 'jh-page__reason' }, el('strong', { text: `${sensitive.length} sensitive question${sensitive.length === 1 ? '' : 's'} U2OS never answers for you` }),
      el('ul', { class: 'jh-list' }, sensitive.map((item) => el('li', { text: item.label ?? item.key ?? 'Unnamed question' }))),
      el('p', { class: 'jh-page__action', text: 'Fill these in yourself on the application form.' })));
  }
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus(); });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
