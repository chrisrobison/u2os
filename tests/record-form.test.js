import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateValues, dateInputToIso, isoToDateInput } from '../public/components/record-form.js';

const fields = [
  { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 10 },
  { name: 'dueAt', label: 'Due date', type: 'date' },
  { name: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] },
  { name: 'flag', label: 'Flag', type: 'checkbox' },
  { name: 'fixed', label: 'Fixed', type: 'text', readOnly: true },
];

test('required fields are reported and optional empty fields become null', () => {
  const { values, errors } = validateValues(fields, { title: '   ', dueAt: '', status: '' });
  assert.deepEqual(errors, { title: 'Title is required.' });
  assert.equal(values.dueAt, null);
  assert.equal(values.status, null);
  assert.equal(values.flag, false);
});

test('text is trimmed and length limited', () => {
  assert.equal(validateValues(fields, { title: '  hello  ' }).values.title, 'hello');
  assert.match(validateValues(fields, { title: 'x'.repeat(11) }).errors.title, /at most 10/);
});

test('read-only fields are never returned', () => {
  const { values } = validateValues(fields, { title: 'a', fixed: 'tampered' });
  assert.equal('fixed' in values, false);
});

test('select values must be one of the options', () => {
  assert.equal(validateValues(fields, { title: 'a', status: 'done' }).values.status, 'done');
  assert.match(validateValues(fields, { title: 'a', status: 'nope' }).errors.status, /invalid choice/);
});

test('an unknown field type fails loudly', () => {
  assert.throws(() => validateValues([{ name: 'x', label: 'X', type: 'color' }], {}), /Unknown field type/);
});

test('dates round trip through the local calendar day, and impossible dates are rejected', () => {
  const iso = dateInputToIso('2026-03-08');
  assert.equal(isoToDateInput(iso), '2026-03-08');
  assert.equal(isoToDateInput(dateInputToIso('2026-12-31')), '2026-12-31');
  assert.equal(dateInputToIso('2026-02-31'), null);
  assert.equal(dateInputToIso('08/03/2026'), null);
  assert.equal(isoToDateInput('not a date'), '');
  assert.match(validateValues(fields, { title: 'a', dueAt: '2026-02-31' }).errors.dueAt, /valid date/);
});
