// Device/capability registry routes. Phase 1 (docs/devices.md) added the
// read-only registry inspection routes below. Phase 2 adds the resolver
// explanation route (GET .../resolve) and capability invocation (POST
// .../invoke) -- both go through the deterministic resolver in
// server/devices/capability-resolver.js, never an LLM decision.
import { sendJson } from '../router.js';
import { newId } from '../../db/ids.js';
import { explainResolution } from '../../devices/capability-resolver.js';
import { invokeCapability, invokeDeviceCapability } from '../../devices/capabilities.js';

export function registerDeviceRoutes(router, { deviceRegistry, capabilityRegistry, eventBus, deviceConnectToken, streamRegistry, developmentMode = false }) {
  const debugEnabled = developmentMode === true && process.env.NODE_ENV !== 'production';
  const denyDebug = (res) => sendJson(res, 403, { code: 'device_debug_disabled', attempted: false,
    error: 'Direct device execution is disabled outside explicit development mode. Use normal authorized tools.' });
  const presentDevice = (device) => ({ ...device, adapterAvailable: Boolean(deviceRegistry.getAdapter(device.adapter)),
    mock: device.adapter === 'mock' });
  // Phase 8 (docs/devices.md): metadata/reference-only stream discovery
  // and open/close -- never a media transport. GET is pure discovery
  // (what streams does this device claim to have); POST .../open actually
  // resolves a reference via the device's adapter (subject to the same
  // trust gate as everything else); the caller connects to that reference
  // directly -- U2OS never proxies the media itself.
  router.get('/api/devices/:id/streams', async (req, res) => {
    try {
      sendJson(res, 200, { streams: streamRegistry.discover(req.params.id) });
    } catch (err) {
      sendJson(res, 404, { error: err.message });
    }
  });

  router.post('/api/devices/:id/streams/:name/open', async (req, res) => {
    if (!debugEnabled) return denyDebug(res);
    try {
      const opened = await streamRegistry.open(req.params.id, req.params.name);
      sendJson(res, 200, opened);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.post('/api/streams/close', async (req, res) => {
    const { streamId } = req.body || {};
    if (!streamId) return sendJson(res, 400, { error: 'streamId is required' });
    const closed = streamRegistry.close(streamId);
    sendJson(res, 200, { closed });
  });

  router.get('/api/streams', async (_req, res) => {
    sendJson(res, 200, { streams: streamRegistry.listOpen() });
  });


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
    sendJson(res, 200, { devices: deviceRegistry.listDevices({ type, owner, location, status, trust, capability }).map(presentDevice), debugActionsEnabled: debugEnabled });
  });

  router.get('/api/devices/:id', async (req, res) => {
    const device = deviceRegistry.getDevice(req.params.id);
    if (!device) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, presentDevice(device));
  });

  // Phase 6 management actions (docs/devices.md): Rename / Set location /
  // Set owner. Deliberately narrow -- never touches status/trust/
  // capabilities, each of which has its own dedicated route below.
  router.patch('/api/devices/:id', async (req, res) => {
    const { name, location, owner } = req.body || {};
    try {
      const updated = deviceRegistry.updateDevice(req.params.id, { name, location, owner });
      sendJson(res, 200, updated);
    } catch (err) {
      sendJson(res, 404, { error: err.message });
    }
  });

  // Pair / Trust / Revoke -- all are just a trust-level transition
  // (untrusted|paired|trusted|revoked). A real pairing *flow* (device-
  // initiated approval request, credential exchange) is Phase 7; this is
  // the owner-driven "just set it" primitive that flow will eventually
  // call into, same as it will still exist for manual override afterward.
  router.post('/api/devices/:id/trust', async (req, res) => {
    const { trust } = req.body || {};
    try {
      const updated = deviceRegistry.setTrust(req.params.id, trust);
      sendJson(res, 200, updated);
    } catch (err) {
      sendJson(res, err.message.startsWith('Unknown device') ? 404 : 400, { error: err.message });
    }
  });

  router.delete('/api/devices/:id', async (req, res) => {
    if (!deviceRegistry.getDevice(req.params.id)) return sendJson(res, 404, { error: 'Not Found' });
    deviceRegistry.removeDevice(req.params.id);
    sendJson(res, 200, { deleted: true, id: req.params.id });
  });

  // "Test capability": directly invokes ONE specific device the owner
  // picked in the management UI -- bypasses the resolver on purpose (see
  // server/devices/capabilities.js's invokeDeviceCapability() header for
  // why this, like the raw invoke route above, is a development-only debug
  // primitive, never something an agent's planning loop reaches).
  router.post('/api/devices/:id/test', async (req, res) => {
    if (!debugEnabled) return denyDebug(res);
    const { capability, args } = req.body || {};
    if (!capability) return sendJson(res, 400, { error: 'capability is required' });
    try {
      const outcome = await invokeDeviceCapability(req.params.id, capability, args || {}, { deviceRegistry, capabilityRegistry, eventBus });
      sendJson(res, 200, outcome);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.get('/api/capabilities', async (_req, res) => {
    sendJson(res, 200, { capabilities: capabilityRegistry.list() });
  });

  router.get('/api/capabilities/:capability/providers', async (req, res) => {
    if (!capabilityRegistry.has(req.params.capability)) {
      return sendJson(res, 404, { error: `Unknown capability: ${req.params.capability}` });
    }
    sendJson(res, 200, { capability: req.params.capability, providers: deviceRegistry.findProvidersFor(req.params.capability).map(presentDevice) });
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
  // SECURITY (development only): unlike
  // presentation.present/presentation.notify (server/tools/presentation-tools.js,
  // reached through Agent.evaluateAndMaybeExecute()), this route calls
  // invokeCapability() DIRECTLY -- it is gated by session auth + CSRF like
  // any private write route, but NOT by PolicyEngine/autonomy level, and
  // produces no agent_actions audit row. Normal operation denies it before
  // adapter access; explicit development mode exposes an authenticated
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
    if (!debugEnabled) return denyDebug(res);
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
