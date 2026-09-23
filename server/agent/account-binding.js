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

export function captureSmtpIdentity() {
  let settings;
  try { settings = validateSmtpSettings(readEncryptedFile('smtp')); }
  catch { throw new Error('SMTP is not configured for the selected IMAP account; no send was proposed'); }
  return { host: settings.host, username: settings.username, from: settings.from };
}

export function assertSmtpIdentity(binding) {
  if (binding?.providerId !== 'imap' || !binding.smtpIdentity) return;
  const current = captureSmtpIdentity();
  if (JSON.stringify(current) !== JSON.stringify(binding.smtpIdentity)) {
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
