import { sendJson } from '../router.js';
export function registerAuthRoutes(router, { auth, agent, demoOwnerEntityId = null }) {
  router.get('/api/auth/status', async (req, res) => sendJson(res, 200, { setupRequired: !auth.hasOwner(), authenticated: Boolean(req.session), csrfToken: req.session?.csrfToken || null }));
  router.post('/api/auth/setup', async (req, res) => { const ownerId = await auth.setup(req.body?.passphrase, { ownerEntityId: demoOwnerEntityId }); agent?.setOwnerEntityId(auth.ownerEntity().id); const session = auth.createSession(ownerId); sendJson(res, 201, { authenticated: true, csrfToken: session.csrf }, { 'Set-Cookie': auth.cookie(req, session.token) }); });
  router.post('/api/auth/login', async (req, res) => { const session = await auth.login(req.body?.passphrase); if (!session) return sendJson(res, 401, { error: 'Invalid credentials' }); sendJson(res, 200, { authenticated: true, csrfToken: session.csrf }, { 'Set-Cookie': auth.cookie(req, session.token) }); });
  router.post('/api/auth/logout', async (req, res) => { auth.logout(req); sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': auth.cookie(req, '', { clear: true }) }); });
  router.get('/api/owner/entity', async (req, res) => sendJson(res, 200, { entity: auth.ownerEntity() }));
  router.put('/api/owner/entity', async (req, res) => {
    const entity = auth.linkOwnerEntity(req.body?.entityId);
    agent?.setOwnerEntityId(entity.id);
    sendJson(res, 200, { entity });
  });
}
