const field = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });

export const CONNECTOR_CATALOG_VERSION = 1;

export const CONNECTOR_CATALOG = [
  {
    id: 'google', name: 'Google', category: 'Productivity', status: 'available', accountMode: 'multiple',
    description: 'Calendar, Gmail, and Contacts through Google OAuth.',
    capabilities: ['calendar', 'email', 'contacts'],
    setup: {
      type: 'oauth2', credentialEndpoint: '/api/connectors/google/credentials',
      fields: [field('clientId', 'OAuth client ID'), field('clientSecret', 'OAuth client secret', 'password')],
      services: [
        { id: 'calendar', label: 'Calendar', providerId: 'google-calendar', domain: 'calendar' },
        { id: 'gmail', label: 'Gmail', providerId: 'gmail', domain: 'email' },
        { id: 'contacts', label: 'Contacts', providerId: 'google-contacts', domain: 'contacts' },
      ],
    },
  },
  {
    id: 'imap', name: 'IMAP', category: 'Email', status: 'available', accountMode: 'multiple',
    description: 'Read and synchronize mail from any TLS IMAP server.', capabilities: ['email.read'],
    setup: { type: 'credentials', credentialEndpoint: '/api/connectors/imap/credentials', disconnectEndpoint: '/api/connectors/imap/disconnect', fields: [field('host', 'Mail host', 'text', { placeholder: 'imap.example.com' }), field('username', 'Username'), field('password', 'App password', 'password')] },
  },
  {
    id: 'smtp', name: 'SMTP', category: 'Email', status: 'available', accountMode: 'multiple',
    description: 'Send mail through a standard SMTP submission server.', capabilities: ['email.send'],
    setup: { type: 'credentials', credentialEndpoint: '/api/connectors/smtp/credentials', disconnectEndpoint: '/api/connectors/smtp/disconnect', fields: [field('host', 'Mail host', 'text', { placeholder: 'smtp.example.com' }), field('port', 'Port', 'select', { options: [{ value: 465, label: '465 (TLS)' }, { value: 587, label: '587 (STARTTLS)' }] }), field('username', 'Username'), field('password', 'App password', 'password'), field('from', 'From address', 'email')] },
  },
  {
    id: 'brave-search', name: 'Brave Search', category: 'Web', status: 'available', accountMode: 'single',
    description: 'Privacy-oriented web search.', capabilities: ['web.search'],
    setup: { type: 'api_key', credentialEndpoint: '/api/connectors/web-search/credentials', fields: [field('apiKey', 'API key', 'password')] },
  },
  {
    id: 'webhook', name: 'Webhook notifications', category: 'Notifications', status: 'available', accountMode: 'multiple',
    description: 'Deliver notifications to JSON or ntfy webhooks.', capabilities: ['notifications.send'],
    setup: { type: 'credentials', credentialEndpoint: '/api/connectors/notify-webhook/credentials', fields: [field('webhookUrl', 'Webhook URL', 'url'), field('format', 'Format', 'select', { options: [{ value: 'json', label: 'JSON' }, { value: 'ntfy', label: 'ntfy' }] })] },
  },
  ...[
    ['rss-atom', 'RSS / Atom', 'News & feeds', 'Follow news sites, blogs, and any standard feed.', ['feed.read']],
    ['pop3', 'POP3', 'Email', 'Import mail from legacy POP3 accounts.', ['email.read']],
    ['discord', 'Discord', 'Messaging', 'Read and send messages in authorized Discord servers.', ['messages.read', 'messages.send']],
    ['whatsapp', 'WhatsApp', 'Messaging', 'Connect WhatsApp conversations through an approved provider.', ['messages.read', 'messages.send']],
    ['imessage', 'iMessage', 'Messaging', 'Read local Messages history through the macOS imsg helper.', ['messages.read']],
    ['slack', 'Slack', 'Messaging', 'Connect workspaces, channels, and direct messages.', ['messages.read', 'messages.send']],
    ['microsoft-365', 'Microsoft 365', 'Productivity', 'Outlook mail, calendars, and contacts through Microsoft Graph.', ['calendar', 'email', 'contacts']],
  ].map(([id, name, category, description, capabilities]) => ({ id, name, category, description, capabilities, status: 'planned', accountMode: 'multiple', setup: { type: 'unavailable', fields: [] } })),
];

export function getConnectorCatalog() {
  return { version: CONNECTOR_CATALOG_VERSION, connectors: CONNECTOR_CATALOG };
}

/** Which providerId(s) (as used in connectors.yaml / connectors-config.js's
 * `active` field) this catalog connector id can appear as a domain's active
 * provider for. For most connectors this is just the connector id itself
 * (imap, brave-search, webhook); google is multi-service, so its OAuth
 * setup's `services` entries carry the real per-domain provider ids
 * (google-calendar/gmail/google-contacts) instead of the literal (and for
 * google, never-matching) connector id. Used both by
 * connection-instances.js's legacy migration (matchingDomains) and by
 * server/api/routes/connectors.js's instance-aware "set active
 * provider/instance" route to check a {connectorId, providerId} pair is
 * actually consistent before persisting it. */
export function providerIdsForConnector(connectorId) {
  const catalog = CONNECTOR_CATALOG.find((c) => c.id === connectorId);
  const ids = new Set([connectorId]);
  for (const service of catalog?.setup?.services || []) {
    if (service.providerId) ids.add(service.providerId);
  }
  return ids;
}

/** Reverse of providerIdsForConnector(): which catalog connector id a given
 * domain-active providerId belongs to (e.g. 'gmail' -> 'google',
 * 'imap' -> 'imap'), or null for a providerId with no catalog owner (e.g.
 * 'mock', or 'caldav', which has no REAL_PROVIDERS module yet). Used by
 * provider-registry.js (issue #163 PR 4) to resolve which connector's
 * connection_instances rows a domain's active provider id should be looked
 * up against. */
export function connectorIdForProviderId(providerId) {
  for (const connector of CONNECTOR_CATALOG) {
    if (providerIdsForConnector(connector.id).has(providerId)) return connector.id;
  }
  return null;
}
