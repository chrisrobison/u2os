import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactStatus, contactLabel, matchesQuery, daysBetween } from '../public/components/record-helpers.js';
import { validateValues, normalizePlainDate } from '../public/components/record-form.js';

const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

test('no cadence means nothing to track', () => {
  assert.deepEqual(contactStatus({}, day(2026, 10, 5)), { state: 'none' });
  assert.deepEqual(contactStatus({ keep_in_touch_days: '0', last_contact: '2026-01-01' }, day(2026, 10, 5)), { state: 'none' });
  assert.deepEqual(contactStatus({ keep_in_touch_days: 'often' }, day(2026, 10, 5)), { state: 'none' });
});

test('a cadence without a last contact is called out, not guessed', () => {
  assert.deepEqual(contactStatus({ keep_in_touch_days: '30' }, day(2026, 10, 5)), { state: 'unknown', cadence: 30 });
  assert.deepEqual(contactStatus({ keep_in_touch_days: '30', last_contact: '2026-02-31' }, day(2026, 10, 5)), { state: 'unknown', cadence: 30 });
});

test('due, overdue and not yet due are counted in calendar days', () => {
  const status = (last, cadence, now) => contactStatus({ last_contact: last, keep_in_touch_days: String(cadence) }, now);
  assert.deepEqual(status('2026-09-21', 14, day(2026, 10, 4)), { state: 'ok', cadence: 14, daysLeft: 1 });
  assert.deepEqual(status('2026-09-21', 14, day(2026, 10, 5)), { state: 'due', cadence: 14, daysOverdue: 0 });
  assert.deepEqual(status('2026-09-21', 14, day(2026, 10, 9, 23)), { state: 'due', cadence: 14, daysOverdue: 4 });
  assert.equal(status('2026-10-05', 7, day(2026, 10, 5)).daysLeft, 7);
});

test('daylight-saving changes do not shift the day count', () => {
  // Spans the US (Mar 8, Nov 1) and EU (Mar 29, Oct 25) changes.
  assert.equal(daysBetween(day(2026, 3, 7), day(2026, 3, 9)), 2);
  assert.equal(daysBetween(day(2026, 3, 28), day(2026, 3, 30)), 2);
  assert.equal(daysBetween(day(2026, 10, 24), day(2026, 10, 26)), 2);
  assert.equal(daysBetween(day(2026, 10, 31), day(2026, 11, 2)), 2);
  assert.equal(daysBetween(day(2026, 12, 31), day(2027, 1, 1)), 1);
});

test('labels read naturally', () => {
  assert.equal(contactLabel({ state: 'due', daysOverdue: 0 }), 'Due to get in touch');
  assert.equal(contactLabel({ state: 'due', daysOverdue: 1 }), 'Overdue by 1 day');
  assert.equal(contactLabel({ state: 'due', daysOverdue: 4 }), 'Overdue by 4 days');
  assert.equal(contactLabel({ state: 'ok', daysLeft: 1 }), 'Next in 1 day');
  assert.equal(contactLabel({ state: 'unknown' }), 'No contact recorded');
  assert.equal(contactLabel({ state: 'none' }), '');
});

test('search ignores case and accents and needs every word', () => {
  const rec = { name: 'José Núñez', fields: { relationship: 'neighbor', organization: 'Acme' } };
  assert.equal(matchesQuery(rec, ''), true);
  assert.equal(matchesQuery(rec, 'jose'), true);
  assert.equal(matchesQuery(rec, 'NUNEZ acme'), true);
  assert.equal(matchesQuery(rec, 'neighbor'), true);
  assert.equal(matchesQuery(rec, 'jose bob'), false);
  assert.equal(matchesQuery({ name: 'Bob' }, 'x'), false);
});

test('a plain date stays a plain string and rejects impossible days', () => {
  assert.equal(normalizePlainDate('2026-12-31'), '2026-12-31');
  assert.equal(normalizePlainDate('2026-02-31'), null);
  assert.equal(normalizePlainDate('12/31/2026'), null);
  assert.equal(normalizePlainDate(''), null);
  const field = [{ name: 'birthday', label: 'Birthday', type: 'plaindate' }];
  assert.equal(validateValues(field, { birthday: '1990-05-01' }).values.birthday, '1990-05-01');
  assert.equal(validateValues(field, { birthday: '' }).values.birthday, null);
  assert.match(validateValues(field, { birthday: '1990-02-30' }).errors.birthday, /valid date/);
});
