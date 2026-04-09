const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const EventBus = require('../core/eventBus');
const { EVENTS } = require('../core/events/event-registry');
const { createMindGraphBridge } = require('../core/bridge/mindgraph-bridge');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeWsServer extends EventEmitter {
  constructor() {
    super();
    setImmediate(() => this.emit('listening'));
  }

  close(callback) {
    this.emit('close');
    if (typeof callback === 'function') callback();
  }
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createBridgeHarness({
  resolveContext,
  config = {}
} = {}) {
  let wsServer = null;
  const eventBus = new EventBus({
    resolveContext: resolveContext || (() => ({ tenantId: 'tenant-a', traceId: 'trace-default' })),
    replayLimit: 10
  });

  const bridge = createMindGraphBridge({
    eventBus,
    config: {
      enabled: true,
      wsPort: 8788,
      authSecret: 'test-secret',
      forwardAllowlist: [EVENTS.CUSTOMER.CREATED, EVENTS.CUSTOMER.UPDATED],
      receiveAllowlist: [EVENTS.CUSTOMER.UPDATED],
      reconnectBaseMs: 5,
      reconnectMaxMs: 25,
      ...config
    },
    logger: silentLogger,
    createWsServer: () => {
      wsServer = new FakeWsServer();
      return wsServer;
    }
  });

  bridge.start();

  return {
    bridge,
    eventBus,
    getServer: () => wsServer
  };
}

function connectTenant(server, { tenantId, secret = 'test-secret' }) {
  const socket = new FakeSocket();
  const req = {
    url: `/?tenantId=${encodeURIComponent(tenantId)}&secret=${encodeURIComponent(secret)}`,
    headers: {}
  };
  server.emit('connection', socket, req);
  return socket;
}

test('bridge forwards allowlisted U2OS events with the standard envelope', async () => {
  let context = { tenantId: 'tenant-a', traceId: 'trace-forward-1' };
  const harness = createBridgeHarness({
    resolveContext: () => context
  });
  const server = harness.getServer();
  const socket = connectTenant(server, { tenantId: 'tenant-a' });

  await harness.eventBus.publish(EVENTS.CUSTOMER.CREATED, { id: 'cust-1' });

  assert.equal(socket.sent.length, 2);
  const forwarded = socket.sent[1];
  assert.equal(forwarded.envelope, '1.0');
  assert.equal(forwarded.tenantId, 'tenant-a');
  assert.equal(forwarded.eventName, EVENTS.CUSTOMER.CREATED);
  assert.deepEqual(forwarded.payload, { id: 'cust-1' });
  assert.equal(forwarded.sourceSystem, 'u2os');
  assert.equal(forwarded.traceId, 'trace-forward-1');
  assert.ok(Number.isFinite(Date.parse(forwarded.publishedAt)));

  context = { tenantId: 'tenant-a', traceId: 'trace-forward-2' };
  await harness.bridge.close();
});

test('bridge enforces tenant isolation when forwarding events', async () => {
  const harness = createBridgeHarness({
    resolveContext: () => ({ tenantId: 'tenant-a', traceId: 'trace-tenant' })
  });
  const server = harness.getServer();
  const tenantASocket = connectTenant(server, { tenantId: 'tenant-a' });
  const tenantBSocket = connectTenant(server, { tenantId: 'tenant-b' });

  await harness.eventBus.publish(EVENTS.CUSTOMER.CREATED, { id: 'cust-2' });

  assert.equal(tenantASocket.sent.length, 2);
  assert.equal(tenantBSocket.sent.length, 1);
  assert.equal(tenantASocket.sent[1].tenantId, 'tenant-a');
  assert.equal(harness.bridge.getStatus().eventsForwarded, 1);

  await harness.bridge.close();
});

test('bridge drops events that are not allowlisted', async () => {
  const harness = createBridgeHarness({
    config: {
      forwardAllowlist: [EVENTS.CUSTOMER.CREATED],
      receiveAllowlist: [EVENTS.CUSTOMER.UPDATED]
    }
  });
  const server = harness.getServer();
  const socket = connectTenant(server, { tenantId: 'tenant-a' });

  await harness.eventBus.publish(EVENTS.CUSTOMER.UPDATED, { id: 'cust-3' });
  assert.equal(socket.sent.length, 1);

  let receivedCount = 0;
  harness.eventBus.subscribe(EVENTS.CUSTOMER.CREATED, () => {
    receivedCount += 1;
  });

  socket.emit('message', Buffer.from(JSON.stringify({
    eventName: EVENTS.CUSTOMER.CREATED,
    tenantId: 'tenant-a',
    payload: { id: 'cust-4' },
    traceId: 'trace-disallowed'
  })));
  await tick();

  assert.equal(receivedCount, 0);
  assert.equal(harness.bridge.getStatus().eventsReceived, 0);

  await harness.bridge.close();
});

test('bridge is non-fatal when websocket connection establishment is unavailable', async () => {
  const eventBus = new EventBus({
    resolveContext: () => ({ tenantId: 'tenant-a', traceId: 'trace-unavailable' })
  });
  const bridge = createMindGraphBridge({
    eventBus,
    config: {
      enabled: true,
      wsPort: 8788,
      authSecret: 'test-secret',
      forwardAllowlist: [EVENTS.CUSTOMER.CREATED],
      receiveAllowlist: [EVENTS.CUSTOMER.CREATED],
      reconnectBaseMs: 5,
      reconnectMaxMs: 25
    },
    logger: silentLogger,
    createWsServer: () => {
      throw new Error('MindGraph bridge unavailable');
    }
  });

  assert.doesNotThrow(() => bridge.start());
  await assert.doesNotReject(() => eventBus.publish(EVENTS.CUSTOMER.CREATED, { id: 'cust-5' }));
  assert.match(bridge.getStatus().lastError || '', /unavailable/i);

  await bridge.close();
});

test('bridge propagates traceId from MindGraph inbound events into U2OS bus', async () => {
  const harness = createBridgeHarness({
    config: {
      receiveAllowlist: [EVENTS.CUSTOMER.UPDATED]
    }
  });
  const server = harness.getServer();
  const socket = connectTenant(server, { tenantId: 'tenant-a' });
  const seen = [];
  harness.eventBus.subscribe(EVENTS.CUSTOMER.UPDATED, (message) => {
    seen.push(message);
  });

  socket.emit('message', Buffer.from(JSON.stringify({
    eventName: EVENTS.CUSTOMER.UPDATED,
    tenantId: 'tenant-a',
    payload: { id: 'cust-6' },
    traceId: 'trace-inbound-1',
    publishedAt: '2026-04-09T00:00:00.000Z',
    sourceSystem: 'mindgraph'
  })));
  await tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tenantId, 'tenant-a');
  assert.equal(seen[0].correlationId, 'trace-inbound-1');
  assert.equal(harness.bridge.getStatus().eventsReceived, 1);

  await harness.bridge.close();
});
