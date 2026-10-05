// Small pure helpers for the people and project lists (#438, #439).

// "YYYY-MM-DD" as a local calendar day, or null.
function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Whole calendar days from `from` to `to`, counted on the calendar so a
// daylight-saving change cannot make a day 23 or 25 hours long.
export function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

// Where a person stands against how often the owner wants to stay in touch.
//   none     no cadence set
//   unknown  a cadence but no recorded last contact
//   ok       contacted recently enough (daysLeft = days until it is due)
//   due      due today or overdue (daysOverdue >= 0)
export function contactStatus(fields = {}, now = new Date()) {
  const cadence = Number(fields.keep_in_touch_days);
  if (!Number.isInteger(cadence) || cadence <= 0) return { state: 'none' };
  const last = parseDay(fields.last_contact);
  if (!last) return { state: 'unknown', cadence };
  const since = daysBetween(last, startOfDay(now));
  const daysOverdue = since - cadence;
  return daysOverdue >= 0 ? { state: 'due', cadence, daysOverdue } : { state: 'ok', cadence, daysLeft: -daysOverdue };
}

export function contactLabel(status) {
  if (status.state === 'due') return status.daysOverdue === 0 ? 'Due to get in touch' : `Overdue by ${status.daysOverdue} day${status.daysOverdue === 1 ? '' : 's'}`;
  if (status.state === 'unknown') return 'No contact recorded';
  if (status.state === 'ok') return `Next in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}`;
  return '';
}

// Case- and accent-insensitive match over the visible text of a record.
export function matchesQuery(record, query) {
  const needle = String(query || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!needle) return true;
  const haystack = [record.name, record.fields?.relationship, record.fields?.organization, record.fields?.email]
    .filter(Boolean).join(' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}
