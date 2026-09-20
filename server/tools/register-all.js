// Small helper (not explicitly named in the file list, but a natural seam):
// builds a fully-populated ToolRegistry with all 13 Phase 1 tools, plus
// the Phase 5 (docs/devices.md) presentation.* tools.
import { ToolRegistry } from './registry.js';
import { EmailSearchTool, EmailReadTool, EmailDraftTool, EmailSendTool } from './email-tools.js';
import { CalendarListTool, CalendarCreateTool, CalendarRescheduleTool } from './calendar-tools.js';
import { ContactsSearchTool } from './contacts-tools.js';
import { TasksListTool, TasksCreateTool, TasksCompleteTool } from './tasks-tools.js';
import { WebSearchTool } from './web-tools.js';
import { NotificationsSendTool } from './notification-tools.js';
import { PresentationPresentTool, PresentationNotifyTool } from './presentation-tools.js';

/**
 * createToolRegistry({ deviceRegistry, capabilityRegistry } = {}) -- the
 * two device-subsystem args are only used by presentation.present/notify
 * (server/tools/presentation-tools.js); every other tool ignores them.
 * Omitting them (as most existing tests do) still builds a complete
 * registry -- the two presentation tools simply throw if actually
 * executed without a device subsystem configured, same fail-safe-at-use
 * (not at construction) posture as an unconnected real connector.
 */
export function createToolRegistry({ deviceRegistry, capabilityRegistry } = {}) {
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
  registry.register(new PresentationPresentTool({ deviceRegistry, capabilityRegistry }));
  registry.register(new PresentationNotifyTool({ deviceRegistry, capabilityRegistry }));
  return registry;
}
