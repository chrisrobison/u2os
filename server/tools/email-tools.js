import { Tool } from './tool.js';
import { getProvider, getProviderForBinding } from '../integrations/provider-registry.js';
import * as mockEmailProvider from '../integrations/mock-email-provider.js';
import { assertSmtpIdentity } from '../agent/account-binding.js';
import { withObservedSender } from './email-sender.js';
import { assertAttachmentRefs, describeAttachments, resolveAttachments } from './email-attachments.js';
import { getVaultDir } from '../vault/vault-dir.js';

const SENDER_DESCRIPTION = ' sender_address is a conservative single mailbox derived from the untrusted From header, not authenticated identity or Reply-To. Use it for recipient references only when non-null; otherwise ask the owner. Original from_addr is preserved. Threaded replies are not supported.';

export class EmailSearchTool extends Tool {
  get name() { return 'email.search'; }
  get domain() { return 'email'; }
  get category() { return 'read'; }
  get requiresAccountBinding() { return true; }
  get description() { return 'Search the selected email account. Gmail returns at most 50 provider-ranked results; IMAP searches its recently synchronized inbox cache. An empty result is not proof that the whole mailbox has no match.' + SENDER_DESCRIPTION; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' }, folder: { type: 'string' } } };
  }
  async execute(args, context) {
    const provider = context?.accountBinding ? getProviderForBinding('email', context.accountBinding) : getProvider('email');
    // The mock uses local fixture search. Real providers handle the query
    // within their selected account and retain the array result contract.
    if (provider.id === mockEmailProvider.id) {
      return (await provider.searchEmails(args)).map(withObservedSender);
    }
    return (await provider.listEmails(args)).map(withObservedSender);
  }
}

export class EmailReadTool extends Tool {
  get name() { return 'email.read'; }
  get domain() { return 'email'; }
  get category() { return 'read'; }
  get requiresAccountBinding() { return true; }
  get description() { return 'Read one message from the bound account.' + SENDER_DESCRIPTION; }
  get schema() {
    return { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  }
  async execute(args, context) {
    const provider = context?.accountBinding ? getProviderForBinding('email', context.accountBinding) : getProvider('email');
    if (provider.id === mockEmailProvider.id) {
      const email = provider.markRead(args.id);
      if (!email) throw new Error(`No such email: ${args.id}`);
      return withObservedSender(email);
    }
    const email = await provider.getEmail(args.id);
    if (!email) throw new Error(`No such email: ${args.id}`);
    return withObservedSender(email);
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
  async execute(args, context) {
    // Draft category: no send, no event, per docs/tools.md. Drafts are
    // always local-only (no real provider has a draft concept wired up this
    // phase), so this keeps using the mock/local store regardless of the
    // active email provider. Personal sender identity is explicitly unset;
    // the later send proposal binds its exact account before approval.
    // `context?.correlationId` is stored on the row
    // as provenance/context (not used for edit-detection matching -- see
    // getDraftById()'s comment in mock-email-provider.js for why). The
    // returned draft's `id` is what a later email.send should pass back as
    // its own `draftId` argument if it wants Phase 7's edit-detection
    // (server/feedback/email-edit-detector.js) to compare against it.
    return mockEmailProvider.createDraft(args, context?.correlationId ?? null);
  }
}

export class EmailSendTool extends Tool {
  get name() { return 'email.send'; }
  get domain() { return 'email'; }
  get category() { return 'consequential'; }
  get schema() {
    return {
      type: 'object',
      properties: {
        to: {},
        subject: { type: 'string' },
        body: { type: 'string' },
        inReplyTo: { type: 'string' },
        // Optional. When this send follows from editing a specific
        // email.draft result, the caller (the model/planner) should pass
        // that draft's id here -- it's inert for the actual send operation
        // itself, but lets Phase 7's feedback loop
        // (server/feedback/email-edit-detector.js) compare the sent
        // content against that EXACT draft, unambiguously, rather than
        // guessing which past draft this "probably" came from.
        draftId: { type: 'string' },
        // Staged attachment references (outbox/<sha256>/<filename>), never file
        // paths. The content is re-hashed at send time: what was approved is
        // what is sent (server/tools/email-attachments.js).
        attachments: { type: 'array' },
      },
      required: ['to', 'subject', 'body'],
    };
  }
  // Plan-time check of the attachment references' shape (no file is touched).
  validateArguments(args) { if (args.attachments !== undefined) assertAttachmentRefs(args.attachments); }
  get description() { return 'Send an email from the selected account. Optional attachments: 1-3 staged attachment references of the form outbox/<sha256>/<filename>, as given to you; never invent one or use a file path.'; }
  async execute(args, context) {
    // Verify attachments first: a missing, changed or unstaged file means nothing is sent.
    const resolved = args.attachments === undefined ? null : resolveAttachments(getVaultDir(), args.attachments);
    assertSmtpIdentity(context?.accountBinding);
    const provider = getProviderForBinding('email', context?.accountBinding);
    // A configured real mailbox must never silently turn an approved send
    // into a mock/local-only send when credentials are missing or revoked.
    if (context.accountBinding.providerId !== 'mock' && provider.id === mockEmailProvider.id) {
      throw new Error('email: configured real provider is not connected; no message was sent');
    }
    const message = resolved ? { ...args, attachments: resolved } : args;
    const sent = await provider.sendEmail(message, { smtpIdentity: context.accountBinding.smtpIdentity });
    const attachments = resolved ? describeAttachments(resolved) : undefined;
    const email = attachments ? { ...sent, attachments } : sent;
    context.eventBus.publish({
      type: 'email.sent',
      source: provider.id,
      actor: context.actor,
      subject: { type: 'email', id: email.id },
      data: { to: email.to_addr, subject: email.subject, ...(attachments ? { attachments } : {}) },
      metadata: { correlationId: context.correlationId, provenance: 'tool:email.send' },
    });
    return email;
  }
}
