// NotificationServiceAdapter -- Phase 9 (docs/devices.md): the
// service-provider unification proof of concept. Per the phase's own
// instructions, this is deliberately NOT a rewrite of the connector system
// (server/integrations/provider-registry.js) -- it's a thin DeviceAdapter
// that wraps ONE existing integration (notifications: mock or the real
// webhook provider, whichever connectors.yaml has active) and exposes it
// through the exact same device/capability model every physical device
// uses. This is the concrete demonstration that "physical device
// capability" and "external service capability" are discoverable and
// invokable through the same resolver architecture -- not two parallel
// systems that happen to look similar.
//
// Why notifications specifically: notification.send is already in the
// Phase 1 capability catalog (server/devices/register-capabilities.js) --
// this adapter is the first thing that actually PROVIDES it. It also
// already has a real (webhook) provider alongside the mock one
// (docs/connectors.md), so this proves the unification works for a real
// integration, not just a mock.
//
// This is intentionally a THIN wrapper, not a reimplementation: invoke()
// delegates straight to provider-registry.js's getProvider('notifications'),
// the exact function server/tools/notification-tools.js already calls --
// switching the active provider in connectors.yaml changes what this
// adapter actually does with zero changes here.
import { DeviceAdapter } from '../device-adapter.js';
import { getProvider } from '../../integrations/provider-registry.js';

const SERVICE_DEVICE_ID = 'service.notifications';

export class NotificationServiceAdapter extends DeviceAdapter {
  get id() {
    return 'service:notifications';
  }

  async discover() {
    return [
      {
        id: SERVICE_DEVICE_ID,
        name: 'Notification Service',
        // type:'service' (not a physical device type like 'camera'/'phone')
        // is exactly the distinction docs/devices.md's Capability Registry
        // diagram draws between Devices and Services as two kinds of
        // Provider under one Capability Registry.
        type: 'service',
        owner: 'household',
        // A local, already-configured integration is a fundamentally
        // different trust situation from a brand-new physical device
        // announcing itself over the wire -- there is no "pairing" step
        // for a service the owner already explicitly configured via
        // connectors.yaml/the Connectors UI. Trusted from the start, same
        // reasoning as MockDeviceAdapter's fixtures (see its file header).
        trust: 'trusted',
        capabilities: ['notification.send'],
        metadata: { domain: 'notifications' },
      },
    ];
  }

  async getDevices() {
    return this.discover();
  }

  async invoke(device, capability, args = {}) {
    if (capability !== 'notification.send') {
      throw new Error(`NotificationServiceAdapter: device "${device.id}" cannot perform capability "${capability}"`);
    }
    const provider = getProvider('notifications');
    return provider.send(args);
  }
}
