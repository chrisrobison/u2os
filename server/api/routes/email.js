import { sendJson } from '../router.js';
import * as emailProvider from '../../integrations/mock-email-provider.js';

export function registerEmailRoutes(router) {
  router.get('/api/email', async (req, res) => {
    const folder = req.query.folder || 'inbox';
    sendJson(res, 200, { emails: emailProvider.searchEmails({ folder }) });
  });
}
