// MockDeviceAdapter: virtual devices with no real hardware behind them, so
// the device/capability subsystem is testable and demoable offline -- the
// exact same role server/integrations/mock-*-provider.js modules play for
// connectors. Registered by default (server/index.js), the same way mock
// connector providers are always available regardless of what real
// connectors are configured.
//
// Devices here are trusted local test fixtures (trust: 'trusted') since
// they are virtual, not real hardware that would need a pairing/approval
// flow -- see docs/devices.md's trust lifecycle for why that distinction
// matters for anything real.
import { DeviceAdapter } from '../device-adapter.js';

const DEVICES = [
  {
    id: 'mock.camera.kitchen',
    name: 'Kitchen Camera (mock)',
    type: 'camera',
    owner: 'household',
    location: 'kitchen',
    trust: 'trusted',
    capabilities: ['image.capture', 'video.stream', 'motion.events'],
  },
  {
    id: 'mock.microphone.office',
    name: 'Office Microphone (mock)',
    type: 'microphone',
    owner: 'chris',
    location: 'office',
    trust: 'trusted',
    capabilities: ['audio.listen'],
  },
  {
    id: 'mock.display.livingroom',
    name: 'Living Room Display (mock)',
    type: 'display',
    owner: 'household',
    location: 'living-room',
    trust: 'trusted',
    capabilities: ['ui.render', 'ui.notify', 'audio.play'],
    metadata: { display: { text: true, cards: true, html: true, images: true, video: true }, input: {} },
  },
  {
    id: 'mock.sensor.temperature.office',
    name: 'Office Temperature Sensor (mock)',
    type: 'sensor',
    owner: 'household',
    location: 'office',
    trust: 'trusted',
    capabilities: ['temperature.read'],
  },
];

export class MockDeviceAdapter extends DeviceAdapter {
  get id() {
    return 'mock';
  }

  async discover() {
    return DEVICES.map((d) => ({ ...d, status: 'online' }));
  }

  async getDevices() {
    return this.discover();
  }

  async invoke(device, capability, args = {}) {
    switch (capability) {
      case 'image.capture':
        return { url: `mock://${device.id}/capture-${Date.now()}.jpg`, capturedAt: new Date().toISOString() };
      case 'temperature.read':
        // Deterministic-ish fake reading, not random -- keeps tests stable.
        return { celsius: 21.5, readAt: new Date().toISOString() };
      case 'ui.render':
        return { delivered: true, device: device.id, content: args.content ?? null };
      case 'ui.notify':
        return { delivered: true, device: device.id, title: args.title ?? null };
      case 'audio.play':
      case 'speech.say':
        return { played: true, device: device.id };
      default:
        throw new Error(`MockDeviceAdapter: device "${device.id}" cannot perform capability "${capability}"`);
    }
  }

  async getStream(device, streamName) {
    if (!device.capabilities?.includes('video.stream')) {
      throw new Error(`MockDeviceAdapter: device "${device.id}" has no stream "${streamName}"`);
    }
    return { url: `stream://${device.id}/${streamName || 'main'}`, protocol: 'mock' };
  }
}
