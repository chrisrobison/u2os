// Real notifications provider: a generic webhook, ntfy.sh-compatible. Per
// docs/connectors.md's "Notifications provider" section. Returns the same
// shape mock-notifications-provider.js's buildNotification() does, so
// notification-tools.js's return contract is unchanged regardless of which
// provider is active.
import { readEncryptedFile } from '../security/vault.js';

export const id = 'webhook';

/** `vaultKey` identifies which `webhook` connection instance to check (issue
 * #163 PR 4) -- required, no default, so a caller can never silently check
 * the wrong account. */
export function isConnected(vaultKey, dataDir) {
  const stored = readEncryptedFile(vaultKey, dataDir);
  return !!stored?.webhookUrl;
}

export async function send({ title, body, priority = 'normal' }, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs = 10_000, signal } = {}) {
  const stored = readEncryptedFile(instance?.vault_key, dataDir);
  if (!stored?.webhookUrl) {
    throw new Error('webhook-notify: not connected');
  }
  const format = stored.format || 'json';
  let res;
  const timeoutController = signal ? null : new AbortController();
  const timeout = timeoutController ? setTimeout(() => timeoutController.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs) : null;
  try {
    const requestSignal = signal || timeoutController.signal;
    if (format === 'ntfy') {
      res = await fetchImpl(stored.webhookUrl, {
        method: 'POST',
        headers: { Title: title, Priority: mapNtfyPriority(priority) },
        body,
        signal: requestSignal,
      });
    } else {
      res = await fetchImpl(stored.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, priority }),
        signal: requestSignal,
      });
    }
  } catch (cause) {
    const timedOut = cause?.name === 'AbortError' || cause?.name === 'TimeoutError';
    const error = new Error(timedOut ? 'webhook-notify: delivery timed out' : 'webhook-notify: delivery failed');
    if (timedOut) error.code = 'ETIMEDOUT';
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!res.ok) {
    const error = new Error(`webhook-notify: send failed (status ${res.status})`);
    error.status = res.status;
    throw error;
  }
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
