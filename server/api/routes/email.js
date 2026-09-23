import { sendJson } from '../router.js';
import * as emailProvider from '../../integrations/mock-email-provider.js';
import { getHealth } from '../../integrations/provider-registry.js';

export function registerEmailRoutes(router) {
  router.get('/api/email', async (req, res) => {
    const folder = req.query.folder || 'inbox';
    const { active, connected, lastSyncAt, mode } = getHealth().find((entry) => entry.domain === 'email');
    sendJson(res, 200, { emails: emailProvider.searchEmails({ folder }), cache: { source: mode === 'demo' ? 'demo-fixture' : 'local-cache', active, connected, lastSyncAt } });
  });
}
