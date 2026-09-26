import { Tool } from './tool.js';
import { getProviderForBinding } from '../integrations/provider-registry.js';

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
    const provider = getProviderForBinding('notifications', context.accountBinding);
    const notification = await provider.send(args);
    context.eventBus.publish({
      type: 'notification.sent',
      source: provider.id,
      actor: context.actor,
      subject: { type: 'notification', id: null },
      data: notification,
      metadata: { correlationId: context.correlationId, provenance: 'tool:notifications.send' },
    });
    return notification;
  }
}
