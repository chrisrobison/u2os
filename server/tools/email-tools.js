import { Tool } from './tool.js';
import * as emailProvider from '../integrations/mock-email-provider.js';

export class EmailSearchTool extends Tool {
  get name() { return 'email.search'; }
  get domain() { return 'email'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' }, folder: { type: 'string' } } };
  }
  async execute(args) {
    return emailProvider.searchEmails(args);
  }
}

export class EmailReadTool extends Tool {
  get name() { return 'email.read'; }
  get domain() { return 'email'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  }
  async execute(args) {
    const email = emailProvider.markRead(args.id);
    if (!email) throw new Error(`No such email: ${args.id}`);
    return email;
  }
}

export class EmailDraftTool extends Tool {
  get name() { return 'email.draft'; }
  get domain() { return 'email'; }
  get category() { return 'draft'; }
  get schema() {
    return {
      type: 'object',
      properties: { to: {}, subject: { type: 'string' }, body: { type: 'string' }, inReplyTo: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    };
  }
  async execute(args) {
    // Draft category: no send, no event, per docs/tools.md.
    return emailProvider.createDraft(args);
  }
}

export class EmailSendTool extends Tool {
  get name() { return 'email.send'; }
  get domain() { return 'email'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: { to: {}, subject: { type: 'string' }, body: { type: 'string' }, inReplyTo: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    };
  }
  async execute(args, context) {
    const email = emailProvider.sendEmail(args);
    context.eventBus.publish({
      type: 'email.sent',
      source: 'mock-email',
      actor: context.actor,
      subject: { type: 'email', id: email.id },
      data: { to: email.to_addr, subject: email.subject },
      metadata: { correlationId: context.correlationId, provenance: 'tool:email.send' },
    });
    return email;
  }
}
