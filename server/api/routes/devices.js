// Device/capability registry routes. Phase 1 (docs/devices.md) added the
// read-only registry inspection routes below. Phase 2 adds the resolver
// explanation route (GET .../resolve) and capability invocation (POST
// .../invoke) -- both go through the deterministic resolver in
// server/devices/capability-resolver.js, never an LLM decision.
import { sendJson } from '../router.js';
import { newId } from '../../db/ids.js';
import { explainResolution } from '../../devices/capability-resolver.js';
import { invokeCapability } from '../../devices/capabilities.js';

export function registerDeviceRoutes(router, { deviceRegistry, capabilityRegistry, eventBus, deviceConnectToken }) {
  // Phase 4: lets an already-authenticated browser session obtain the
  // /ws/devices transport token itself, rather than needing filesystem
  // access to server/devices/realtime/device-token.js's persisted file.
  // Requires a session like any other private route -- an unauthenticated
  // caller can never learn this token through the API.
  router.get('/api/devices/connect-token', async (_req, res) => {
    sendJson(res, 200, { token: deviceConnectToken });
  });

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

  // Debug/inspection: "why was/would this device be chosen?" -- per
  // docs/devices.md's resolver explanation output. Read-only; resolving
  // never invokes anything.
  router.get('/api/capabilities/:capability/resolve', async (req, res) => {
    if (!capabilityRegistry.has(req.params.capability)) {
      return sendJson(res, 404, { error: `Unknown capability: ${req.params.capability}` });
    }
    const { audience, privacy, location } = req.query;
    try {
      const explanation = explainResolution(req.params.capability, { audience, privacy, location }, { deviceRegistry, capabilityRegistry });
      sendJson(res, 200, explanation);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  // Actual invocation: resolves an eligible device deterministically, then
  // delegates to that device's adapter. See server/devices/capabilities.js
  // for what is (and, per docs/devices.md, is NOT yet) enforced here.
  //
  // SECURITY (known gap, tracked in docs/devices.md): unlike
  // presentation.present/presentation.notify (server/tools/presentation-tools.js,
  // reached through Agent.evaluateAndMaybeExecute()), this route calls
  // invokeCapability() DIRECTLY -- it is gated by session auth + CSRF like
  // any private write route, but NOT by PolicyEngine/autonomy level, and
  // produces no agent_actions audit row. Treat this as a trusted-owner-only
  // debug/direct-control surface, not something an agent's own planning
  // loop should ever be given access to call.
  //
  // SECURITY (known gap, tracked in docs/devices.md): `audience` is
  // client-supplied, not derived from the authenticated session -- this
  // system is currently single-owner, and device.owner values (e.g.
  // "chris"/"household") are adapter-defined strings with no formal
  // mapping to the one authenticated owner yet. Nothing here is a
  // trust/authorization decision based on unverified caller identity --
  // it only affects WHICH device is chosen, and the resolver already
  // refuses to hand private/sensitive-tier content to a device whose
  // trust is insufficient regardless of what audience the caller claims.
  // Binding `audience` to the authenticated owner is expected to land
  // alongside the semantic present() API (docs/devices.md Phase 5).
  router.post('/api/capabilities/:capability/invoke', async (req, res) => {
    if (!capabilityRegistry.has(req.params.capability)) {
      return sendJson(res, 404, { error: `Unknown capability: ${req.params.capability}` });
    }
    const { args, audience, privacy, location, sourceDevice } = req.body || {};
    try {
      const outcome = await invokeCapability(
        req.params.capability,
        args || {},
        { audience, privacy, location, sourceDevice, session: req.session?.id ?? null, correlationId: newId('corr') },
        { deviceRegistry, capabilityRegistry, eventBus }
      );
      sendJson(res, 200, outcome);
    } catch (err) {
      sendJson(res, err.explanation ? 409 : 400, { error: err.message, explanation: err.explanation });
    }
  });
}
