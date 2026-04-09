const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTopics, topicMatchesEnvelope } = require('../core/realtimeGateway');

test('normalizeTopics keeps valid topics and removes invalid values', () => {
  const topics = normalizeTopics([
    'customer.created',
    'customer.created',
    'transportation.*',
    'context:billing',
    'entity:customer',
    'bad topic',
    '',
    '*'
  ], 10);

  assert.deepEqual(topics, [
    'customer.created',
    'transportation.*',
    'context:billing',
    'entity:customer',
    '*'
  ]);
});

test('topicMatchesEnvelope supports exact, prefix, context, and entity routing', () => {
  const envelope = {
    type: 'transportation.trip.scheduled',
    context: 'transportation',
    entity: 'trip'
  };

  assert.equal(topicMatchesEnvelope('transportation.trip.scheduled', envelope), true);
  assert.equal(topicMatchesEnvelope('transportation.*', envelope), true);
  assert.equal(topicMatchesEnvelope('context:transportation', envelope), true);
  assert.equal(topicMatchesEnvelope('entity:trip', envelope), true);
  assert.equal(topicMatchesEnvelope('entity:customer', envelope), false);
  assert.equal(topicMatchesEnvelope('customer.created', envelope), false);
});
