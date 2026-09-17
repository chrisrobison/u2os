// Notifications have no dedicated table in the fixed Phase 1 schema
// (server/db/schema.sql is specified verbatim and does not include one). The
// event log itself is the durable record here: notifications.send's effect is
// fully captured by the notification.sent event it publishes (see
// tools/notification-tools.js), which persists title/body/priority in the
// event's `data` field. This is the one intentional deviation from "every
// tool inserts a row" in docs/tools.md, made necessary by the fixed schema.
export const id = 'mock-notifications';

export function buildNotification({ title, body, priority = 'normal' }) {
  return { title, body, priority, sentAt: new Date().toISOString() };
}

// Provider-interface shim so provider-registry.js can treat notifications
// uniformly across mock/real providers (notification-tools.js still calls
// buildNotification directly for the mock path's exact historical shape).
export function send(args) {
  return buildNotification(args);
}
