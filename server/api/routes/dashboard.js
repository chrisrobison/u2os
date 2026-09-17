import { sendJson } from '../router.js';
import { validateDashboard } from '../dashboard-schema.js';
import * as calendarProvider from '../../integrations/mock-calendar-provider.js';
import * as tasksProvider from '../../integrations/mock-tasks-provider.js';
import { listPendingActions } from '../../policy/policy-engine.js';

export function registerDashboardRoutes(router) {
  router.get('/api/dashboard/morning', async (_req, res) => {
    const now = new Date();
    const today = now.toDateString();

    const todaysEvents = calendarProvider.listEvents({}).filter((e) => new Date(e.start_at).toDateString() === today);
    const priorityTasks = tasksProvider.listTasks({ status: 'open' }).slice(0, 5);
    const pendingActions = listPendingActions();

    const schema = {
      title: 'Morning Briefing',
      layout: 'dashboard',
      components: [
        { type: 'schedule', source: 'calendar.today', data: { events: todaysEvents } },
        { type: 'task-list', source: 'tasks.priority', data: { tasks: priorityTasks } },
        { type: 'approval', source: 'actions.pending', data: { actions: pendingActions } },
      ],
    };

    validateDashboard(schema);
    sendJson(res, 200, schema);
  });
}
