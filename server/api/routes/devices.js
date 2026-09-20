// Read-only device/capability registry routes -- Phase 1 (docs/devices.md).
// Invocation (POST /api/devices/:id/invoke) is deliberately NOT added yet:
// it needs an execution context and the trust/privacy-aware resolver from a
// later phase, not just a registry lookup. These routes exist so the
// registry is inspectable (curl-able) the same way GET /api/triggers is,
// without granting any new authority -- every device/capability here was
// already fully knowable to anything with server-side code access.
import { sendJson } from '../router.js';

export function registerDeviceRoutes(router, { deviceRegistry, capabilityRegistry }) {
  router.get('/api/devices', async (req, res) => {
    const { type, owner, location, status, trust, capability } = req.query;
    sendJson(res, 200, { devices: deviceRegistry.listDevices({ type, owner, location, status, trust, capability }) });
  });

  router.get('/api/devices/:id', async (req, res) => {
    const device = deviceRegistry.getDevice(req.params.id);
    if (!device) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, device);
  });

  router.get('/api/capabilities', async (_req, res) => {
    sendJson(res, 200, { capabilities: capabilityRegistry.list() });
  });

  router.get('/api/capabilities/:capability/providers', async (req, res) => {
    if (!capabilityRegistry.has(req.params.capability)) {
      return sendJson(res, 404, { error: `Unknown capability: ${req.params.capability}` });
    }
    sendJson(res, 200, { capability: req.params.capability, providers: deviceRegistry.findProvidersFor(req.params.capability) });
  });
}
