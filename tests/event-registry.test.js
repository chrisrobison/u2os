const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EVENTS,
  EVENT_NAMES,
  EVENT_PAYLOAD_TYPEDEFS
} = require('../core/events/event-registry');

function collectEventNames(node, bucket = []) {
  for (const value of Object.values(node || {})) {
    if (typeof value === 'string') {
      bucket.push(value);
      continue;
    }
    collectEventNames(value, bucket);
  }
  return bucket;
}

test('event names are unique', () => {
  const names = collectEventNames(EVENTS);
  const unique = new Set(names);

  assert.equal(unique.size, names.length, 'duplicate event name strings found in registry');
  assert.equal(EVENT_NAMES.length, names.length, 'EVENT_NAMES should include every event in EVENTS');
});

test('event names follow dot notation', () => {
  const names = collectEventNames(EVENTS);
  const dotNotationPattern = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;

  for (const name of names) {
    assert.match(name, dotNotationPattern, `event name is not valid dot notation: ${name}`);
  }
});

test('all events have corresponding payload typedefs', () => {
  const names = collectEventNames(EVENTS);
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'events', 'event-registry.js'), 'utf8');
  const typedefNames = new Set(
    Array.from(source.matchAll(/@typedef\s+\{[^}]+\}\s+([A-Za-z0-9_]+)/g), (match) => match[1])
  );

  for (const name of names) {
    assert.ok(EVENT_PAYLOAD_TYPEDEFS[name], `missing payload typedef mapping for event ${name}`);
    assert.ok(
      typedefNames.has(EVENT_PAYLOAD_TYPEDEFS[name]),
      `missing JSDoc typedef '${EVENT_PAYLOAD_TYPEDEFS[name]}' for event ${name}`
    );
  }
});
