import { sendJson } from '../router.js';
import * as calendarProvider from '../../integrations/mock-calendar-provider.js';

export function registerCalendarRoutes(router) {
  router.get('/api/calendar/events', async (req, res) => {
    const range = req.query.range || 'upcoming';
    const events = calendarProvider.listEvents({});
    const now = new Date();

    let filtered = events;
    if (range === 'today') {
      const today = now.toDateString();
      filtered = events.filter((e) => new Date(e.start_at).toDateString() === today);
    } else if (range === 'upcoming') {
      filtered = events.filter((e) => new Date(e.start_at).getTime() >= now.getTime() - 60 * 60 * 1000);
    }

    sendJson(res, 200, { events: filtered });
  });
}
