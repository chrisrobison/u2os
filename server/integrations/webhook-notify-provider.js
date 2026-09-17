// Real notifications provider: a generic webhook, ntfy.sh-compatible. Per
// docs/connectors.md's "Notifications provider" section. Returns the same
// shape mock-notifications-provider.js's buildNotification() does, so
// notification-tools.js's return contract is unchanged regardless of which
// provider is active.
import { readEncryptedFile } from '../security/vault.js';

export const id = 'webhook';

export function isConnected(dataDir) {
  const stored = readEncryptedFile('notify-webhook', dataDir);
  return !!stored?.webhookUrl;
}

export async function send({ title, body, priority = 'normal' }, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const stored = readEncryptedFile('notify-webhook', dataDir);
  if (!stored?.webhookUrl) {
    throw new Error('webhook-notify: not connected');
  }
  const format = stored.format || 'json';
  let res;
  if (format === 'ntfy') {
    res = await fetchImpl(stored.webhookUrl, {
      method: 'POST',
      headers: { Title: title, Priority: mapNtfyPriority(priority) },
      body,
    });
  } else {
    res = await fetchImpl(stored.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, priority }),
    });
  }
  if (!res.ok) throw new Error(`webhook-notify: send failed (status ${res.status})`);
  return { title, body, priority, sentAt: new Date().toISOString() };
}

function mapNtfyPriority(priority) {
  switch (priority) {
    case 'urgent':
      return '5';
    case 'high':
      return '4';
    case 'low':
      return '2';
    default:
      return '3';
  }
}
