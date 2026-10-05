import { sendJson } from '../router.js';
import * as emailProvider from '../../integrations/mock-email-provider.js';
import { getHealth } from '../../integrations/provider-registry.js';
import { observedSenderAddress } from '../../tools/email-sender.js';

export function registerEmailRoutes(router) {
  router.get('/api/email', async (req, res) => {
    const folder = req.query.folder || 'inbox';
    const { active, connected, lastSyncAt, mode } = getHealth().find((entry) => entry.domain === 'email');
    sendJson(res, 200, { emails: emailProvider.searchEmails({ folder }), cache: { source: mode === 'demo' ? 'demo-fixture' : 'local-cache', active, connected, lastSyncAt } });
  });

  // One cached message for the mail dialog. The body is private content, so
  // this route never logs it. `sender_address` is the conservative parse of
  // the untrusted From header (null when ambiguous), and `provider` tells the
  // client which kind of reply link makes sense.
  router.get('/api/email/:id', async (req, res) => {
    const email = emailProvider.getEmail(req.params.id);
    if (!email) return sendJson(res, 404, { error: 'No such message' });
    const provider = email.id.startsWith('gmail_') ? 'gmail' : email.id.startsWith('imap_') ? 'imap' : 'other';
    sendJson(res, 200, { email: { ...email, sender_address: observedSenderAddress(email.from_addr), provider } });
  });
}
