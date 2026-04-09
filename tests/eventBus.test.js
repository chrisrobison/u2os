const test = require('node:test');
const assert = require('node:assert/strict');

const EventBus = require('../core/eventBus');

test('event bus publish emits canonical envelope and legacy fields', async () => {
  let currentContext = {
    tenantId: 'tenant-a',
    userId: 'user-1',
    traceId: 'trace-123'
  };
  const bus = new EventBus({
    resolveContext: () => currentContext,
    replayLimit: 10
  });

  const seen = [];
  bus.subscribe('customer.created', async (message) => {
    seen.push(message);
  });

  const envelope = await bus.publish('customer.created', {
    entity: 'customers',
    id: 'abc123'
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].eventName, 'customer.created');
  assert.equal(seen[0].emittedAt, envelope.ts);
  assert.equal(seen[0].sequence, envelope.sequence);
  assert.equal(envelope.type, 'customer.created');
  assert.equal(envelope.version, 'v1');
  assert.equal(envelope.tenantId, 'tenant-a');
  assert.equal(envelope.actorId, 'user-1');
  assert.equal(envelope.correlationId, 'trace-123');
  assert.equal(envelope.context, 'customer');
  assert.equal(envelope.entity, 'customers');
  assert.equal(bus.getCurrentSequence('tenant-a'), 1);

  currentContext = {
    tenantId: 'tenant-b',
    userId: 'user-2',
    traceId: 'trace-999'
  };
  const envelopeTwo = await bus.publish('transportation.trip.scheduled', {
    tripId: 'trip-1'
  });
  assert.equal(envelopeTwo.sequence, 1);
  assert.equal(bus.getCurrentSequence('tenant-b'), 1);
});

test('event bus listSince replays tenant-scoped events by sequence', async () => {
  let tenantId = 'tenant-a';
  const bus = new EventBus({
    resolveContext: () => ({ tenantId }),
    replayLimit: 5
  });

  await bus.publish('customer.created', { id: 'c-1' });
  await bus.publish('customer.updated', { id: 'c-1' });
  await bus.publish('customer.deleted', { id: 'c-1' });

  tenantId = 'tenant-b';
  await bus.publish('invoice.created', { id: 'i-1' });

  const replayA = bus.listSince({
    tenantId: 'tenant-a',
    afterSequence: 1,
    limit: 10
  });
  assert.equal(replayA.length, 2);
  assert.equal(replayA[0].type, 'customer.updated');
  assert.equal(replayA[1].type, 'customer.deleted');
  assert.equal(replayA[0].sequence, 2);
  assert.equal(replayA[1].sequence, 3);

  const replayB = bus.listSince({
    tenantId: 'tenant-b',
    afterSequence: 0,
    limit: 10
  });
  assert.equal(replayB.length, 1);
  assert.equal(replayB[0].type, 'invoice.created');
  assert.equal(replayB[0].sequence, 1);
});
