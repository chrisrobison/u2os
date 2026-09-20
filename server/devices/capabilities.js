// Capability invocation -- Phase 2 (docs/devices.md). The agent-facing
// "commands" half of the device bus: `invokeCapability(id, args, request,
// deps)` resolves an eligible device via capability-resolver.js and
// delegates execution to that device's adapter, publishing
// capability.invoked/capability.failed on the shared EventBus either way.
//
// This is intentionally NOT yet wired into server/policy/policy-engine.js's
// tool-authorization pipeline or agent_actions audit log -- see
// docs/devices.md's "Known gaps" for why that integration is deferred to
// the phase that adds the semantic present()/agent-facing API, rather than
// bolted on here ahead of an actual caller. What IS enforced here,
// unconditionally: trust/privacy-aware device selection (never an LLM
// decision) and a defense-in-depth re-check that the chosen device hasn't
// been revoked between resolution and execution.
import { explainResolution } from './capability-resolver.js';

/**
 * buildExecutionContext(request, device) -> the execution-context shape
 * docs/devices.md documents (actor/session/sourceDevice/location/
 * authenticationLevel/privacy), plus which device was actually targeted.
 * Exported so callers building this from an authenticated session's own
 * fields can see exactly what's expected without repeating the caller's
 * request object.
 */
export function buildExecutionContext(request = {}, device) {
  return {
    actor: request.audience ?? null,
    session: request.session ?? null,
    sourceDevice: request.sourceDevice ?? null,
    location: request.location ?? null,
    authenticationLevel: request.authenticationLevel ?? null,
    privacy: request.privacy ?? 'public',
    targetDevice: device?.id ?? null,
  };
}

/**
 * invokeCapability(capabilityId, args, request, { deviceRegistry, capabilityRegistry, eventBus })
 * -> { device: deviceId, result, explanation }
 *
 * Throws if the capability is unknown, no device is eligible, or the
 * chosen device's adapter's invoke() itself throws. Always publishes
 * exactly one of capability.invoked / capability.failed before returning
 * or throwing (when an eventBus is provided).
 */
export async function invokeCapability(capabilityId, args = {}, request = {}, { deviceRegistry, capabilityRegistry, eventBus } = {}) {
  // Validates the capability id up front (throws "Unknown capability" --
  // the required "unsupported capability" behavior) before anything else.
  const explanation = explainResolution(capabilityId, request, { deviceRegistry, capabilityRegistry });

  if (!explanation.chosen) {
    publish(eventBus, {
      type: 'capability.failed',
      source: 'capability-resolver',
      subject: { type: 'capability', id: capabilityId },
      data: { capability: capabilityId, request: explanation.request, reason: 'no_eligible_provider', candidates: explanation.candidates },
      correlationId: request.correlationId,
    });
    const err = new Error(`No eligible device for capability "${capabilityId}"`);
    err.explanation = explanation;
    throw err;
  }

  const device = deviceRegistry.getDevice(explanation.chosen);
  // Defense in depth: the resolver already excludes revoked devices, but
  // re-check at the moment of execution in case trust changed between
  // resolve and invoke (e.g. a concurrent revocation).
  if (!device || device.trust === 'revoked') {
    publish(eventBus, {
      type: 'capability.failed',
      source: 'capability-resolver',
      subject: { type: 'device', id: explanation.chosen },
      data: { capability: capabilityId, reason: 'device_revoked_at_invoke_time' },
      correlationId: request.correlationId,
    });
    throw new Error(`Device "${explanation.chosen}" is no longer eligible (revoked)`);
  }

  const adapter = deviceRegistry.getAdapter(device.adapter);
  if (!adapter) {
    throw new Error(`Adapter "${device.adapter}" for device "${device.id}" is not registered`);
  }

  const context = buildExecutionContext(request, device);
  try {
    const result = await adapter.invoke(device, capabilityId, args, context);
    publish(eventBus, {
      type: 'capability.invoked',
      source: `device:${device.id}`,
      subject: { type: 'device', id: device.id },
      data: { capability: capabilityId, deviceId: device.id, args, result },
      correlationId: request.correlationId,
    });
    return { device: device.id, result, explanation };
  } catch (err) {
    publish(eventBus, {
      type: 'capability.failed',
      source: `device:${device.id}`,
      subject: { type: 'device', id: device.id },
      data: { capability: capabilityId, deviceId: device.id, reason: 'adapter_invoke_failed', error: err.message },
      correlationId: request.correlationId,
    });
    throw err;
  }
}

function publish(eventBus, partial) {
  if (!eventBus) return;
  eventBus.publish(partial);
}
