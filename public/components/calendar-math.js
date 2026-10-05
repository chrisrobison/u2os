// Date math for the calendar views (#437). Pure functions, no DOM, all in the
// viewer's local time. Days are handled with calendar fields (setDate and the
// Date constructor), never by adding 24 hours, so daylight-saving changes
// cannot shift a day boundary.

export const VIEWS = ['list', 'day', 'week', 'month'];

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfWeek(date, weekStartsOn = 0) {
  const day = startOfDay(date);
  const offset = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -offset);
}

export function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// Moves by whole months, keeping the day of the month where it exists and
// clamping otherwise (Jan 31 + 1 month = Feb 28/29, never Mar 3).
export function addMonths(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(target.getFullYear(), target.getMonth(), day);
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The weeks shown for a month: whole weeks from the one holding the 1st to
// the one holding the last day, each an array of seven local-midnight dates.
export function monthGrid(anchor, weekStartsOn = 0) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth(), daysInMonth(anchor.getFullYear(), anchor.getMonth()));
  const weeks = [];
  for (let cursor = startOfWeek(first, weekStartsOn); cursor <= last; cursor = addDays(cursor, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
  }
  return weeks;
}

// The [from, to) interval a view needs events for.
export function rangeFor(view, anchor, weekStartsOn = 0) {
  if (view === 'day') {
    const from = startOfDay(anchor);
    return { from, to: addDays(from, 1) };
  }
  if (view === 'week') {
    const from = startOfWeek(anchor, weekStartsOn);
    return { from, to: addDays(from, 7) };
  }
  if (view === 'month') {
    const weeks = monthGrid(anchor, weekStartsOn);
    return { from: weeks[0][0], to: addDays(weeks[weeks.length - 1][6], 1) };
  }
  throw new Error(`No date range for view: ${view}`);
}

export function shift(view, anchor, direction) {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  if (view === 'month') return addMonths(anchor, direction);
  throw new Error(`Cannot shift view: ${view}`);
}

export function periodLabel(view, anchor, weekStartsOn = 0, locale) {
  if (view === 'day') return anchor.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (view === 'month') return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  if (view === 'week') {
    const from = startOfWeek(anchor, weekStartsOn);
    const to = addDays(from, 6);
    const short = { month: 'short', day: 'numeric' };
    return `${from.toLocaleDateString(locale, short)} – ${to.toLocaleDateString(locale, { ...short, year: 'numeric' })}`;
  }
  return '';
}

function bounds(event) {
  const start = new Date(event.start_at);
  if (Number.isNaN(start.getTime())) return null;
  const parsedEnd = event.end_at ? new Date(event.end_at) : null;
  const end = parsedEnd && !Number.isNaN(parsedEnd.getTime()) && parsedEnd > start ? parsedEnd : start;
  return { start, end };
}

// Events that fall on a local calendar day, earliest first. An event that
// spans midnight appears on each day it touches; an event ending exactly at
// midnight does not spill into the next day.
export function eventsOnDay(events, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return events
    .map((event) => ({ event, span: bounds(event) }))
    .filter(({ span }) => span && span.start < dayEnd && (span.end > dayStart || (span.end.getTime() === span.start.getTime() && span.start >= dayStart)))
    .sort((a, b) => a.span.start - b.span.start)
    .map(({ event }) => event);
}
