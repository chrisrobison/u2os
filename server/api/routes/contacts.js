import { sendJson } from '../router.js';
import * as contactsProvider from '../../integrations/mock-contacts-provider.js';

export function registerContactsRoutes(router) {
  router.get('/api/contacts', async (req, res) => {
    sendJson(res, 200, { contacts: contactsProvider.searchContacts({ query: req.query.query }) });
  });
}
