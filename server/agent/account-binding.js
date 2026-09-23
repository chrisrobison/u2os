import { getDb } from '../db/connection.js';
import { findInstance } from '../integrations/connection-instances.js';
import { isGrandfatheredInstance } from '../integrations/connector-instance-ids.js';
import { readEncryptedFile } from '../security/vault.js';
import { validateSettings as validateSmtpSettings } from '../integrations/smtp-transport.js';

export const ACCOUNT_BOUND_ACTION_DOMAINS = Object.freeze({
  'email.send': 'email',
  'calendar.create': 'calendar',
  'calendar.reschedule': 'calendar',
});

export function accountDomainForAction(toolName) {
  return ACCOUNT_BOUND_ACTION_DOMAINS[toolName] || null;
}

export function captureSmtpIdentity(imapBinding) {
  const imap = findInstance(getDb(), 'imap', imapBinding.instanceId);
  const smtp = imap?.smtp_instance_id && findInstance(getDb(), 'smtp', imap.smtp_instance_id);
  if (!smtp || smtp.status !== 'connected') throw new Error('Select a connected SMTP sender for this IMAP account; no send was proposed');
  let settings;
  try { settings = validateSmtpSettings(readEncryptedFile(smtp.vault_key)); }
  catch { throw new Error('SMTP is not configured for the selected IMAP account; no send was proposed'); }
  return { instanceId: smtp.id, credentialRevision: smtp.credential_revision, label: smtp.label, from: settings.from };
}

export function assertSmtpIdentity(binding) {
  if (binding?.providerId !== 'imap') return;
  if (!binding.smtpIdentity?.instanceId) throw new Error('SMTP account binding is missing; new approval is required');
  const current = captureSmtpIdentity(binding);
  if (current.instanceId !== binding.smtpIdentity.instanceId || current.credentialRevision !== binding.smtpIdentity.credentialRevision || current.from !== binding.smtpIdentity.from) {
    throw new Error('SMTP sender identity changed since approval; no message was attempted');
  }
}

export function assertCalendarTarget(binding, eventId) {
  const event = getDb().prepare('SELECT id, source FROM calendar_events WHERE id = ?').get(eventId);
  if (!event) throw new Error('Calendar event is unavailable; no change was attempted');
  if (binding?.providerId === 'mock') {
    if (event.source === 'mock-calendar') return;
  } else if (binding?.providerId === 'google-calendar' && event.source === 'google-calendar') {
    const instance = findInstance(getDb(), 'google', binding.instanceId);
    if (instance) {
      const expected = `gcal_${instance.id}_`;
      if (!isGrandfatheredInstance(instance) && event.id.startsWith(expected)) return;
      if (isGrandfatheredInstance(instance) && event.id.startsWith('gcal_') && !event.id.startsWith('gcal_conn_')) return;
    }
  }
  throw new Error('Calendar event belongs to a different account; no change was attempted');
}
