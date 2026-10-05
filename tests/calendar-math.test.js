import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startOfDay, addDays, addMonths, startOfWeek, monthGrid, rangeFor, shift, eventsOnDay, sameDay, dayKey, daysInMonth,
} from '../public/components/calendar-math.js';

// Dates are built from calendar fields in the machine's local time, and the
// assertions compare calendar fields too, so these hold in any time zone.
const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const fields = (date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];

test('adding days crosses month and year boundaries and keeps local midnight', () => {
  assert.deepEqual(fields(addDays(d(2026, 1, 31), 1)), [2026, 2, 1]);
  assert.deepEqual(fields(addDays(d(2026, 1, 1), -1)), [2025, 12, 31]);
  assert.equal(addDays(d(2026, 3, 8, 15), 0).getHours(), 0);
});

test('adding days across daylight-saving changes never shifts the calendar day', () => {
  // US changes on 2026-03-08 and 2026-11-01, the EU on 2026-03-29 and 2026-10-25.
  for (const [y, m, day] of [[2026, 3, 7], [2026, 3, 28], [2026, 10, 24], [2026, 10, 31]]) {
    const next = addDays(d(y, m, day), 1);
    assert.deepEqual(fields(next), fields(new Date(y, m - 1, day + 1)));
    assert.equal(next.getHours(), 0);
  }
});

test('months clamp to the last day instead of overflowing', () => {
  assert.deepEqual(fields(addMonths(d(2026, 1, 31), 1)), [2026, 2, 28]);
  assert.deepEqual(fields(addMonths(d(2028, 1, 31), 1)), [2028, 2, 29]);
  assert.deepEqual(fields(addMonths(d(2026, 12, 15), 1)), [2027, 1, 15]);
  assert.deepEqual(fields(addMonths(d(2026, 1, 15), -1)), [2025, 12, 15]);
  assert.equal(daysInMonth(2028, 1), 29);
});

test('weeks start on the requested day', () => {
  // 2026-10-07 is a Wednesday.
  assert.deepEqual(fields(startOfWeek(d(2026, 10, 7), 0)), [2026, 10, 4]);
  assert.deepEqual(fields(startOfWeek(d(2026, 10, 7), 1)), [2026, 10, 5]);
  assert.deepEqual(fields(startOfWeek(d(2026, 10, 4), 0)), [2026, 10, 4]);
  assert.deepEqual(fields(startOfWeek(d(2026, 10, 4), 1)), [2026, 9, 28]);
});

test('a month grid is whole weeks covering every day exactly once', () => {
  for (const weekStart of [0, 1]) {
    const weeks = monthGrid(d(2026, 10, 15), weekStart);
    assert.ok(weeks.every((week) => week.length === 7));
    const days = weeks.flat();
    assert.equal(days[0].getDay(), weekStart);
    assert.equal(new Set(days.map(dayKey)).size, days.length);
    for (let day = 1; day <= 31; day++) assert.ok(days.some((x) => sameDay(x, d(2026, 10, day))), `Oct ${day}`);
  }
  assert.equal(monthGrid(d(2026, 2, 1), 0).length, 4, 'February 2026 starts on a Sunday and fits four weeks');
  assert.equal(monthGrid(d(2026, 8, 1), 0).length, 6, 'August 2026 needs six weeks');
});

test('ranges are [from, to) and match each view', () => {
  const day = rangeFor('day', d(2026, 10, 7, 15));
  assert.deepEqual([fields(day.from), fields(day.to)], [[2026, 10, 7], [2026, 10, 8]]);
  const week = rangeFor('week', d(2026, 10, 7), 0);
  assert.deepEqual([fields(week.from), fields(week.to)], [[2026, 10, 4], [2026, 10, 11]]);
  const month = rangeFor('month', d(2026, 10, 7), 0);
  assert.deepEqual([fields(month.from), fields(month.to)], [[2026, 9, 27], [2026, 11, 1]]);
  assert.throws(() => rangeFor('list', d(2026, 10, 7)), /No date range/);
});

test('shift moves by the view unit', () => {
  assert.deepEqual(fields(shift('day', d(2026, 10, 7), 1)), [2026, 10, 8]);
  assert.deepEqual(fields(shift('week', d(2026, 10, 7), -1)), [2026, 9, 30]);
  assert.deepEqual(fields(shift('month', d(2026, 10, 31), 1)), [2026, 11, 30]);
});

test('events land on every day they touch, in time order', () => {
  const events = [
    { id: 'late', title: 'Late', start_at: d(2026, 10, 7, 18).toISOString(), end_at: d(2026, 10, 7, 19).toISOString() },
    { id: 'early', title: 'Early', start_at: d(2026, 10, 7, 8).toISOString(), end_at: d(2026, 10, 7, 9).toISOString() },
    { id: 'overnight', title: 'Overnight', start_at: d(2026, 10, 7, 22).toISOString(), end_at: d(2026, 10, 8, 2).toISOString() },
    { id: 'ends-at-midnight', title: 'Midnight', start_at: d(2026, 10, 7, 23).toISOString(), end_at: d(2026, 10, 8, 0).toISOString() },
    { id: 'no-end', title: 'No end', start_at: d(2026, 10, 8, 10).toISOString() },
    { id: 'bad', title: 'Bad', start_at: 'not a date' },
  ];
  assert.deepEqual(eventsOnDay(events, d(2026, 10, 7)).map((e) => e.id), ['early', 'late', 'overnight', 'ends-at-midnight']);
  assert.deepEqual(eventsOnDay(events, d(2026, 10, 8)).map((e) => e.id), ['overnight', 'no-end']);
  assert.deepEqual(eventsOnDay(events, d(2026, 10, 9)), []);
});

test('startOfDay drops the time', () => {
  const s = startOfDay(d(2026, 10, 7, 15, 45));
  assert.deepEqual([s.getHours(), s.getMinutes()], [0, 0]);
});
