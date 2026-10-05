// Field-schema driven record forms for the shared section pattern (#434).
//
// A field is { name, label, type, required?, options?, help?, readOnly?,
// maxLength?, placeholder? } where type is one of: text, textarea, date,
// select, checkbox. `validateValues` is pure (no DOM) so it can be unit
// tested and reused by any caller; `buildForm` and `readForm` are the thin
// DOM layer on top of it.

const TYPES = new Set(['text', 'textarea', 'date', 'plaindate', 'datetime', 'select', 'checkbox']);

// <input type="date"> yields "YYYY-MM-DD". A date-only due date is stored as
// the end of that local day so it does not read as overdue during the day.
export function dateInputToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d, 23, 59, 0, 0);
  // Reject rollovers such as 2026-02-31.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

// A plain calendar day, or null for anything that is not a real date.
export function normalizePlainDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? String(value) : null;
}

// <input type="datetime-local"> yields "YYYY-MM-DDTHH:MM" in local time.
export function datetimeInputToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, y, m, d, hh, mm] = match.map(Number);
  const date = new Date(y, m - 1, d, hh, mm, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || date.getHours() !== hh || date.getMinutes() !== mm) return null;
  return date.toISOString();
}

export function isoToDatetimeInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${isoToDateInput(iso)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isoToDateInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// raw: { [name]: string | boolean }. Returns { values, errors } where errors
// maps field name -> message. Optional empty fields are returned as null.
export function validateValues(fields, raw = {}) {
  const values = {};
  const errors = {};
  for (const field of fields) {
    if (!TYPES.has(field.type)) throw new Error(`Unknown field type: ${field.type}`);
    if (field.readOnly) continue;
    const input = raw[field.name];

    if (field.type === 'checkbox') {
      values[field.name] = Boolean(input);
      continue;
    }

    const text = typeof input === 'string' ? input.trim() : '';
    if (!text) {
      if (field.required) errors[field.name] = `${field.label} is required.`;
      else values[field.name] = null;
      continue;
    }
    if (field.maxLength && text.length > field.maxLength) {
      errors[field.name] = `${field.label} must be at most ${field.maxLength} characters.`;
      continue;
    }
    if (field.type === 'date') {
      const iso = dateInputToIso(text);
      if (!iso) errors[field.name] = `${field.label} must be a valid date.`;
      else values[field.name] = iso;
      continue;
    }
    if (field.type === 'plaindate') {
      const day = normalizePlainDate(text);
      if (!day) errors[field.name] = `${field.label} must be a valid date.`;
      else values[field.name] = day;
      continue;
    }
    if (field.type === 'datetime') {
      const iso = datetimeInputToIso(text);
      if (!iso) errors[field.name] = `${field.label} must be a valid date and time.`;
      else values[field.name] = iso;
      continue;
    }
    if (field.type === 'select') {
      const allowed = (field.options || []).map((option) => String(option.value));
      if (!allowed.includes(text)) errors[field.name] = `${field.label} has an invalid choice.`;
      else values[field.name] = text;
      continue;
    }
    values[field.name] = text;
  }
  return { values, errors };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

// Builds a <form> for `fields`, populated from `values` (record values keyed
// by field name; date fields take ISO strings). Every control gets a real
// <label>, and each field has an error slot wired with aria-describedby.
export function buildForm(fields, values = {}, { idPrefix = 'rf' } = {}) {
  const form = el('form', { class: 'record-form', novalidate: true });
  for (const field of fields) {
    const id = `${idPrefix}-${field.name}`;
    const errorId = `${id}-error`;
    const helpId = `${id}-help`;
    const describedBy = [field.help ? helpId : null, errorId].filter(Boolean).join(' ');
    const current = values[field.name];

    let control;
    if (field.type === 'textarea') {
      control = el('textarea', { id, name: field.name, rows: field.rows || 4, maxlength: field.maxLength });
      control.value = current ?? '';
    } else if (field.type === 'select') {
      control = el('select', { id, name: field.name });
      if (!field.required) control.append(el('option', { value: '', text: '' }));
      for (const option of field.options || []) {
        control.append(el('option', { value: String(option.value), text: option.label }));
      }
      control.value = current == null ? '' : String(current);
    } else if (field.type === 'checkbox') {
      control = el('input', { id, name: field.name, type: 'checkbox' });
      control.checked = Boolean(current);
    } else if (field.type === 'date') {
      control = el('input', { id, name: field.name, type: 'date' });
      control.value = isoToDateInput(current);
    } else if (field.type === 'plaindate') {
      control = el('input', { id, name: field.name, type: 'date' });
      control.value = normalizePlainDate(current) || '';
    } else if (field.type === 'datetime') {
      control = el('input', { id, name: field.name, type: 'datetime-local' });
      control.value = isoToDatetimeInput(current);
    } else {
      control = el('input', { id, name: field.name, type: 'text', maxlength: field.maxLength, placeholder: field.placeholder });
      control.value = current ?? '';
    }
    if (field.required) control.setAttribute('aria-required', 'true');
    if (field.readOnly) {
      control.setAttribute(control.tagName === 'SELECT' || field.type === 'checkbox' ? 'disabled' : 'readonly', '');
    }
    control.setAttribute('aria-describedby', describedBy);

    const label = el('label', { for: id, text: field.label });
    const children = field.type === 'checkbox' ? [control, label] : [label, control];
    if (field.help) children.push(el('div', { id: helpId, class: 'record-form__help', text: field.help }));
    children.push(el('div', { id: errorId, class: 'record-form__error', role: 'alert' }));
    form.append(el('div', { class: `record-form__field${field.type === 'checkbox' ? ' is-checkbox' : ''}`, dataset: { field: field.name } }, children));
  }
  return form;
}

export function readForm(form, fields) {
  const raw = {};
  for (const field of fields) {
    const control = form.elements.namedItem(field.name);
    if (!control) continue;
    raw[field.name] = field.type === 'checkbox' ? control.checked : control.value;
  }
  return validateValues(fields, raw);
}

// Shows errors next to their fields and moves focus to the first invalid one.
// Passing an empty object clears every message.
export function showErrors(form, errors = {}) {
  let first = null;
  for (const slot of form.querySelectorAll('.record-form__field')) {
    const name = slot.dataset.field;
    const message = errors[name] || '';
    slot.querySelector('.record-form__error').textContent = message;
    const control = form.elements.namedItem(name);
    if (control) {
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      if (message && !first) first = control;
    }
  }
  if (first) first.focus();
  return Boolean(first);
}
