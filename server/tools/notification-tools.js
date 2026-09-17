import { Tool } from './tool.js';
import { buildNotification } from '../integrations/mock-notifications-provider.js';

export class NotificationsSendTool extends Tool {
  get name() { return 'notifications.send'; }
  get domain() { return 'notifications'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' } },
      required: ['title', 'body'],
    };
  }
  async execute(args, context) {
    const notification = buildNotification(args);
    context.eventBus.publish({
      type: 'notification.sent',
      source: 'mock-notifications',
      actor: context.actor,
      subject: { type: 'notification', id: null },
      data: notification,
      metadata: { correlationId: context.correlationId, provenance: 'tool:notifications.send' },
    });
    return notification;
  }
}
