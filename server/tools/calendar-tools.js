import { Tool } from './tool.js';
import { getProvider } from '../integrations/provider-registry.js';

export class CalendarListTool extends Tool {
  get name() { return 'calendar.list'; }
  get domain() { return 'calendar'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } };
  }
  async execute(args) {
    const provider = getProvider('calendar');
    return provider.listEvents(args);
  }
}

export class CalendarCreateTool extends Tool {
  get name() { return 'calendar.create'; }
  get domain() { return 'calendar'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startAt: { type: 'string' },
        endAt: { type: 'string' },
        attendees: { type: 'array' },
        location: { type: 'string' },
      },
      required: ['title', 'startAt', 'endAt'],
    };
  }
  async execute(args, context) {
    const provider = getProvider('calendar'); // resolved per-call, so switching providers takes effect without a restart
    const event = await provider.createEvent(args);
    context.eventBus.publish({
      type: 'calendar.event_added',
      source: provider.id,
      actor: context.actor,
      subject: { type: 'calendar_event', id: event.id },
      data: { after: event },
      metadata: { correlationId: context.correlationId, provenance: 'tool:calendar.create' },
    });
    return event;
  }
}

export class CalendarRescheduleTool extends Tool {
  get name() { return 'calendar.reschedule'; }
  get domain() { return 'calendar'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: { eventId: { type: 'string' }, newStartAt: { type: 'string' }, newEndAt: { type: 'string' } },
      required: ['eventId', 'newStartAt', 'newEndAt'],
    };
  }
  async execute(args, context) {
    const provider = getProvider('calendar');
    const change = await provider.rescheduleEvent(args.eventId, {
      newStartAt: args.newStartAt,
      newEndAt: args.newEndAt,
    });
    if (!change) throw new Error(`No such calendar event: ${args.eventId}`);
    context.eventBus.publish({
      type: 'calendar.event_changed',
      source: provider.id,
      actor: context.actor,
      subject: { type: 'calendar_event', id: args.eventId },
      data: { before: change.before, after: change.after },
      metadata: { correlationId: context.correlationId, provenance: 'tool:calendar.reschedule' },
    });
    return change.after;
  }
}
