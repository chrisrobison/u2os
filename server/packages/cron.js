// Five-field cron expressions ("minute hour day-of-month month day-of-week")
// for schedule triggers, evaluated in local server time like routines.
// Supports *, numbers, lists (1,3), ranges (1-5), steps (*/15, 0-30/10) and
// day names (mon-fri). No seconds, no @macros beyond @hourly/@daily/@weekly.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0' };

export function parseCron(expression) {
  const text = MACROS[String(expression).trim()] || String(expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron must have five fields: minute hour day-of-month month day-of-week');
  const sets = parts.map((part, index) => parseField(part.toLowerCase(), FIELDS[index]));
  if (sets[4].has(7)) { sets[4].delete(7); sets[4].add(0); }
  return {
    minutes: sets[0], hours: sets[1], days: sets[2], months: sets[3], weekdays: sets[4],
    // Standard cron: when both day fields are restricted, either may match.
    dayOr: parts[2] !== '*' && parts[4] !== '*',
  };
}

function parseField(part, field) {
  const values = new Set();
  for (const item of part.split(',')) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new Error(`invalid ${field.name} "${item}"`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) throw new Error(`invalid ${field.name} step`);
    let [lo, hi] = match[1] === '*' ? [field.min, field.max] : match[1].split('-').map((v) => toNumber(v, field));
    if (hi === undefined) hi = match[2] === undefined ? lo : field.max;
    if (lo < field.min || hi > field.max || lo > hi) throw new Error(`${field.name} out of range`);
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

function toNumber(value, field) {
  if (field.name === 'day of week' && Object.hasOwn(DAYS, value)) return DAYS[value];
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${field.name} "${value}"`);
  return Number(value);
}

export function isValidCron(expression) {
  try { parseCron(expression); return true; } catch { return false; }
}

function matchesDay(cron, date) {
  const dom = cron.days.has(date.getDate());
  const dow = cron.weekdays.has(date.getDay());
  return cron.dayOr ? dom || dow : dom && dow;
}

/** The first matching minute strictly after `from`, or null within ~4 years. */
export function nextCronTime(expression, from = new Date()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const date = new Date(from.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 86_400_000;
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0, 0, 0); continue; }
    if (!matchesDay(cron, date)) { date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue; }
    if (!cron.hours.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minutes.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1, 0, 0); continue; }
    return date;
  }
  return null;
}
