import { el } from './jh-util.js';

// The add-interview and add-task forms shown inside Job Details. Plain DOM
// forms: every label is tied to its field, errors are announced, Escape
// cancels. They only build the request body; the caller sends it.

export const KINDS = [['video', 'Video call'], ['phone', 'Phone call'], ['onsite', 'Onsite'], ['other', 'Other']];
const LIMITS = { title: 200, round: 80, location: 500, notes: 2000, name: 120, contactTitle: 120, email: 254 };
export const ROLE_KINDS = [['recruiter', 'Recruiter'], ['referral', 'Referral'], ['hiring_manager', 'Hiring Manager'], ['other', 'Other']];

let counter = 0;

function field(label, input) {
  const id = `jh-f-${++counter}`;
  input.id = id;
  return el('div', { class: 'jh-field' }, el('label', { class: 'jh-field__label', for: id, text: label }), input);
}

const input = (type, props = {}) => el('input', { type, class: 'jh-input', autocomplete: 'off', ...props });

/** A datetime-local value (the owner's local time) as an ISO instant, or null when empty or unreadable. */
export function localToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shell({ title, fields, submitLabel, onSubmit, onCancel }) {
  const error = el('p', { class: 'load-error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: submitLabel });
  const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
  const form = el('form', { class: 'jh-form', 'aria-label': title, novalidate: true }, el('h4', { class: 'jh-section__title', text: title }), ...fields,
    error, el('div', { class: 'jh-actions' }, submit, cancel));
  const fail = (message) => { error.hidden = false; error.textContent = message; };
  cancel.addEventListener('click', onCancel);
  form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try { await onSubmit(fail); } finally { submit.disabled = false; }
  });
  return form;
}

export function interviewForm({ onSubmit, onCancel }) {
  const at = input('datetime-local', { required: true });
  const ends = input('datetime-local');
  const kind = el('select', { class: 'jh-input' }, KINDS.map(([value, label]) => el('option', { value, text: label })));
  const round = input('text', { maxlength: LIMITS.round, placeholder: 'Round 1, Panel...' });
  const where = input('text', { maxlength: LIMITS.location, placeholder: 'Meeting link or address' });
  const notes = input('text', { maxlength: LIMITS.notes });
  return shell({
    title: 'Add an interview', submitLabel: 'Add interview', onCancel,
    fields: [field('Starts', at), field('Ends (optional)', ends), field('Format', kind), field('Round (optional)', round), field('Link or location (optional)', where), field('Notes (optional)', notes)],
    async onSubmit(fail) {
      const start = localToIso(at.value);
      if (!start) return fail('Choose when the interview starts.');
      const end = ends.value ? localToIso(ends.value) : null;
      if (ends.value && !end) return fail('The end time is not a valid time.');
      if (end && end <= start) return fail('The end time must be after the start.');
      await onSubmit({ at: start, endsAt: end, kind: kind.value, round: round.value, locationOrLink: where.value, notes: notes.value }, fail);
    },
  });
}

export function taskForm({ onSubmit, onCancel }) {
  const title = input('text', { required: true, maxlength: LIMITS.title, placeholder: 'Send a thank-you note' });
  const due = input('datetime-local');
  return shell({
    title: 'Add a task', submitLabel: 'Add task', onCancel,
    fields: [field('Task', title), field('Due (optional)', due)],
    async onSubmit(fail) {
      if (!title.value.trim()) return fail('Give the task a title.');
      const dueAt = due.value ? localToIso(due.value) : null;
      if (due.value && !dueAt) return fail('The due time is not a valid time.');
      await onSubmit({ title: title.value, dueAt }, fail);
    },
  });
}

/** A mailto-safe address: one plain address, nothing that could add recipients or header lines. */
export function plainEmail(value) {
  return typeof value === 'string' && value.length <= LIMITS.email && /^[^\s@,;:<>"()[\]\\]{1,64}@[^\s@,;:<>"()[\]\\]+\.[^\s@,;:<>"()[\]\\]+$/.test(value);
}

/**
 * Add (with `jobs`, a list of {id, company, role}) or edit (with `contact`) a networking contact. The address
 * cannot be changed once saved, so the edit form leaves it out.
 */
export function contactForm({ jobs = [], contact = null, onSubmit, onCancel }) {
  const job = el('select', { class: 'jh-input' }, jobs.map((item) => el('option', { value: item.id, text: [item.company, item.role].filter(Boolean).join(' - ') })));
  const name = input('text', { required: true, maxlength: LIMITS.name, placeholder: 'Jane Doe', value: contact?.name ?? '' });
  const email = input('email', { required: true, maxlength: LIMITS.email, placeholder: 'jane@example.com' });
  const kind = el('select', { class: 'jh-input' }, ROLE_KINDS.map(([value, label]) => el('option', { value, text: label })));
  kind.value = contact?.roleKind ?? 'recruiter';
  const title = input('text', { maxlength: LIMITS.contactTitle, placeholder: 'Technical Recruiter', value: contact?.title ?? '' });
  const fields = contact
    ? [field('Name', name), field('Role', kind), field('Title (optional)', title)]
    : [field('Job', job), field('Name', name), field('Email', email), field('Role', kind), field('Title (optional)', title)];
  return shell({
    title: contact ? 'Edit contact' : 'Add a contact', submitLabel: contact ? 'Save contact' : 'Add contact', onCancel, fields,
    async onSubmit(fail) {
      if (!name.value.trim()) return fail('Give the contact a name.');
      if (!contact) {
        if (!job.value) return fail('There are no jobs to attach a contact to yet.');
        if (!plainEmail(email.value.trim())) return fail('Enter one valid email address, like jane@example.com.');
        return onSubmit({ jobId: job.value, name: name.value, email: email.value.trim(), roleKind: kind.value, title: title.value }, fail);
      }
      await onSubmit({ name: name.value, roleKind: kind.value, title: title.value }, fail);
    },
  });
}
