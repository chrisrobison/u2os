import { Tool } from './tool.js';
import { getProvider } from '../integrations/provider-registry.js';
import * as mockEmailProvider from '../integrations/mock-email-provider.js';

export class EmailSearchTool extends Tool {
  get name() { return 'email.search'; }
  get domain() { return 'email'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' }, folder: { type: 'string' } } };
  }
  async execute(args) {
    const provider = getProvider('email');
    // Real providers expose listEmails({folder}) (no free-text query
    // support per docs/connectors.md); the mock's richer searchEmails
    // (subject/body/from LIKE query) stays available whichever provider is
    // active, matching this tool's existing return contract exactly.
    if (provider.id === mockEmailProvider.id) {
      return provider.searchEmails(args);
    }
    return provider.listEmails(args);
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
    const provider = getProvider('email');
    if (provider.id === mockEmailProvider.id) {
      const email = provider.markRead(args.id);
      if (!email) throw new Error(`No such email: ${args.id}`);
      return email;
    }
    const email = await provider.getEmail(args.id);
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
    // Draft category: no send, no event, per docs/tools.md. Drafts are
    // always local-only (no real provider has a draft concept wired up this
    // phase), so this keeps using the mock/local store regardless of the
    // active email provider.
    return mockEmailProvider.createDraft(args);
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
    const provider = getProvider('email');
    const email = await provider.sendEmail(args);
    context.eventBus.publish({
      type: 'email.sent',
      source: provider.id,
      actor: context.actor,
      subject: { type: 'email', id: email.id },
      data: { to: email.to_addr, subject: email.subject },
      metadata: { correlationId: context.correlationId, provenance: 'tool:email.send' },
    });
    return email;
  }
}
