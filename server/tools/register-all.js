// Small helper (not explicitly named in the file list, but a natural seam):
// builds a fully-populated ToolRegistry with all 13 Phase 1 tools.
import { ToolRegistry } from './registry.js';
import { EmailSearchTool, EmailReadTool, EmailDraftTool, EmailSendTool } from './email-tools.js';
import { CalendarListTool, CalendarCreateTool, CalendarRescheduleTool } from './calendar-tools.js';
import { ContactsSearchTool } from './contacts-tools.js';
import { TasksListTool, TasksCreateTool, TasksCompleteTool } from './tasks-tools.js';
import { WebSearchTool } from './web-tools.js';
import { NotificationsSendTool } from './notification-tools.js';

export function createToolRegistry() {
  const registry = new ToolRegistry();
  const ToolClasses = [
    EmailSearchTool,
    EmailReadTool,
    EmailDraftTool,
    EmailSendTool,
    CalendarListTool,
    CalendarCreateTool,
    CalendarRescheduleTool,
    ContactsSearchTool,
    TasksListTool,
    TasksCreateTool,
    TasksCompleteTool,
    WebSearchTool,
    NotificationsSendTool,
  ];
  for (const ToolClass of ToolClasses) {
    registry.register(new ToolClass());
  }
  return registry;
}
