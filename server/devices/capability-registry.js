// CapabilityRegistry: the semantic vocabulary devices and services are
// described in terms of -- "image.capture", "ui.render", "speech.say" --
// never a hard-coded string scattered through call sites. Mirrors
// server/tools/registry.js's shape deliberately (register/get/has/list,
// duplicate-registration throws) since capabilities and tools play the same
// structural role: a fixed, code-defined, in-memory catalog of "things that
// can be invoked", populated once at startup by register-capabilities.js,
// the same way register-all.js populates ToolRegistry.
//
// A capability definition is NOT a device. It never lists "supported
// providers" itself -- which devices currently support a given capability is
// a dynamic, runtime fact (a device can come and go), computed by
// DeviceRegistry.findProvidersFor(capabilityId) by scanning currently-known
// devices, not stored here. See docs/devices.md.
export class CapabilityRegistry {
  constructor() {
    this._capabilities = new Map();
  }

  /**
   * register(capability) -- capability: {
   *   id,                    // "image.capture"
   *   description,
   *   inputSchema,           // JSON-Schema-like, optional (defaults to permissive)
   *   outputSchema,          // JSON-Schema-like, optional
   *   privacy,               // 'public' | 'personal' | 'private' | 'sensitive'
   *                          //   -- same vocabulary as
   *                          //   server/policy/data-processing-policy.js's
   *                          //   classification, deliberately: a capability's
   *                          //   privacy is the same kind of fact about
   *                          //   what leaves the device, just for hardware/
   *                          //   service I/O rather than memory facts.
   *   defaultAuthorization,  // 'always' | 'autonomous' | 'confirm' | 'never'
   *                          //   -- same vocabulary as
   *                          //   server/policy/policy-engine.js's levelKey.
   *                          //   This is only ever a DEFAULT/advisory value
   *                          //   a resolver or policy layer may consult; it
   *                          //   is not itself an authorization decision,
   *                          //   and nothing in this module enforces it.
   * }
   */
  register(capability) {
    if (!capability || typeof capability.id !== 'string' || !capability.id) {
      throw new Error('Capability.id is required');
    }
    if (this._capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    const normalized = {
      id: capability.id,
      description: capability.description || '',
      inputSchema: capability.inputSchema || { type: 'object', properties: {}, required: [] },
      outputSchema: capability.outputSchema || { type: 'object' },
      privacy: PRIVACY_LEVELS.has(capability.privacy) ? capability.privacy : 'personal',
      defaultAuthorization: AUTH_LEVELS.has(capability.defaultAuthorization) ? capability.defaultAuthorization : 'confirm',
    };
    this._capabilities.set(normalized.id, normalized);
    return normalized;
  }

  get(id) {
    const capability = this._capabilities.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    return capability;
  }

  has(id) {
    return this._capabilities.has(id);
  }

  list() {
    return [...this._capabilities.values()];
  }
}

const PRIVACY_LEVELS = new Set(['public', 'personal', 'private', 'sensitive']);
const AUTH_LEVELS = new Set(['always', 'autonomous', 'confirm', 'never']);
