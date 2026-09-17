// MOCK / DETERMINISTIC model provider. This is NOT a real LLM call -- it is
// pattern-matching good enough to drive the Phase 1 vertical slice and a
// couple of other demo utterances. See docs/architecture.md ("Phase 1 ships
// a MockModelProvider that does deterministic intent-matching").
import { ModelProvider } from './model-provider.js';

const RESCHEDULE_PATTERN = /\b(?:move|reschedule)\b.*?\bwith\s+([A-Za-z][\w'-]*)\b.*?\bto\s+(.+?)[.!]?$/i;
const HOUR_PATTERN = /(\d{1,2})\s*(am|pm)/i;
const REMINDER_PATTERN = /\bremind me to\s+(.+?)[.!]?$/i;
const SCHEDULE_QUERY_PATTERN = /\b(what'?s|show|list)\b.*\b(calendar|schedule|today)\b/i;

export class MockModelProvider extends ModelProvider {
  async plan(context, objective) {
    const text = String(objective || '').trim();

    const reschedule = await this._planReschedule(context, text);
    if (reschedule) return reschedule;

    const reminder = this._planReminder(text);
    if (reminder) return reminder;

    const scheduleQuery = await this._planScheduleQuery(context, text);
    if (scheduleQuery) return scheduleQuery;

    return {
      reasoning_summary: `I'm not sure how to help with "${text}" yet -- Phase 1's mock planner only recognizes a few demo intents (rescheduling a meeting, "remind me to...", "what's on my calendar").`,
      actions: [],
    };
  }

  async respond(_context, message) {
    return `You said: ${message}`;
  }

  async evaluateEvent(event, _context) {
    return { shouldNotify: false, reason: `No evaluation rule for ${event.type} yet (Phase 1 mock).` };
  }

  async summarize(items) {
    return `${items.length} item(s).`;
  }

  async extractEntities(_content) {
    return [];
  }

  async _planReschedule(context, text) {
    const match = text.match(RESCHEDULE_PATTERN);
    if (!match) return null;
    const [, name, relativePhraseRaw] = match;
    const relativePhrase = relativePhraseRaw.trim();

    const calendarTool = context.toolRegistry.get('calendar.list');
    const events = await calendarTool.execute({}, this._toolContext(context));

    let candidates = events.filter((event) => (event.attendees || []).some((attendee) => matchesName(attendee, name)));

    const hourMatch = text.match(HOUR_PATTERN);
    if (hourMatch && candidates.length > 1) {
      const hour = to24Hour(hourMatch[1], hourMatch[2]);
      const narrowed = candidates.filter((event) => new Date(event.start_at).getHours() === hour);
      if (narrowed.length) candidates = narrowed;
    }

    const event = candidates[0];
    if (!event) {
      return {
        reasoning_summary: `I couldn't find an existing meeting with ${name} to reschedule.`,
        actions: [],
      };
    }

    const durationMs = new Date(event.end_at).getTime() - new Date(event.start_at).getTime();
    const { newStartAt, newEndAt } = resolveRelativeTime(
      relativePhrase,
      new Date(),
      durationMs > 0 ? durationMs : 60 * 60 * 1000
    );

    return {
      reasoning_summary: `Found "${event.title}" with ${name} at ${event.start_at}. Proposing to move it to ${newStartAt} per "${relativePhrase}".`,
      actions: [{ tool: 'calendar.reschedule', arguments: { eventId: event.id, newStartAt, newEndAt } }],
    };
  }

  _planReminder(text) {
    const match = text.match(REMINDER_PATTERN);
    if (!match) return null;
    const title = match[1].trim();
    if (!title) return null;
    return {
      reasoning_summary: `Creating a task so you don't forget: "${title}".`,
      actions: [{ tool: 'tasks.create', arguments: { title } }],
    };
  }

  async _planScheduleQuery(context, text) {
    if (!SCHEDULE_QUERY_PATTERN.test(text)) return null;

    const calendarTool = context.toolRegistry.get('calendar.list');
    const events = await calendarTool.execute({}, this._toolContext(context));
    const today = new Date().toDateString();
    const todays = events.filter((event) => new Date(event.start_at).toDateString() === today);

    const summary = todays.length
      ? todays.map((event) => `${formatTime(event.start_at)} -- ${event.title}`).join('; ')
      : 'nothing on your calendar today';

    return { reasoning_summary: `Today: ${summary}.`, actions: [] };
  }

  _toolContext(context) {
    return { eventBus: context.eventBus, correlationId: context.correlationId, actor: context.actor };
  }
}

function matchesName(attendee, name) {
  const attendeeName = typeof attendee === 'string' ? attendee : attendee?.name || '';
  return attendeeName.toLowerCase().includes(name.toLowerCase());
}

function to24Hour(hourStr, ampm) {
  let hour = parseInt(hourStr, 10) % 12;
  if (/pm/i.test(ampm)) hour += 12;
  return hour;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Resolves a relative time phrase ("tomorrow afternoon", "this morning", ...)
 * into an ISO start/end pair, given `now` and a duration to preserve. Kept
 * deliberately simple: day offset from a small keyword set, hour from a
 * time-of-day keyword, default to a conservative "tomorrow afternoon" style
 * fallback (never same-day-in-the-past) when nothing recognizable is found.
 */
function resolveRelativeTime(phrase, now, durationMs) {
  const p = phrase.toLowerCase();
  const date = new Date(now);

  if (p.includes('tomorrow')) {
    date.setDate(date.getDate() + 1);
  } else if (p.includes('today') || p.includes('this ')) {
    // keep same day
  } else {
    date.setDate(date.getDate() + 1);
  }

  let hour = 14;
  if (p.includes('morning')) hour = 9;
  else if (p.includes('afternoon')) hour = 14;
  else if (p.includes('evening') || p.includes('night')) hour = 18;

  date.setHours(hour, 0, 0, 0);
  const start = new Date(date);
  const end = new Date(start.getTime() + durationMs);
  return { newStartAt: start.toISOString(), newEndAt: end.toISOString() };
}
