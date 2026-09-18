import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../server/logging/logger.js';

// Captures console.log/warn/error output for the duration of `fn`, then
// restores the originals in a finally so a failing assertion never leaves
// stdout permanently patched for later tests.
async function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = { log: [], warn: [], error: [] };
  console.log = (line) => lines.log.push(line);
  console.warn = (line) => lines.warn.push(line);
  console.error = (line) => lines.error.push(line);
  try {
    await fn();
    return lines;
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test('logger: pretty (default) format is human-readable and includes timestamp, level, component, message, fields', async () => {
  delete process.env.LOG_FORMAT;
  try {
    const lines = await captureConsole(() => {
      log.info('test-component', 'something happened', { userId: 'u1', count: 3 });
    });
    assert.equal(lines.log.length, 1);
    const line = lines.log[0];

    // ISO-8601 timestamp present.
    assert.match(line, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    assert.match(line, /INFO/i);
    assert.match(line, /\[test-component\]/);
    assert.match(line, /something happened/);
    assert.match(line, /userId=u1/);
    assert.match(line, /count=3/);

    // Not JSON in pretty mode.
    assert.throws(() => JSON.parse(line));
  } finally {
    delete process.env.LOG_FORMAT;
  }
});

test('logger: warn/error route to console.warn/console.error respectively in pretty mode', async () => {
  delete process.env.LOG_FORMAT;
  try {
    const lines = await captureConsole(() => {
      log.warn('test-component', 'a warning', { reason: 'because' });
      log.error('test-component', 'an error', { reason: 'because' });
    });
    assert.equal(lines.log.length, 0);
    assert.equal(lines.warn.length, 1);
    assert.equal(lines.error.length, 1);
    assert.match(lines.warn[0], /WARN/i);
    assert.match(lines.error[0], /ERROR/i);
  } finally {
    delete process.env.LOG_FORMAT;
  }
});

test('logger: LOG_FORMAT=json emits single-line JSON with timestamp, level, component, message, and fields', async () => {
  process.env.LOG_FORMAT = 'json';
  try {
    const lines = await captureConsole(() => {
      log.info('test-component', 'something happened', { userId: 'u1', count: 3 });
    });
    assert.equal(lines.log.length, 1);
    const line = lines.log[0];

    // Single line -- no embedded newlines.
    assert.doesNotMatch(line, /\n/);

    const parsed = JSON.parse(line);
    assert.match(parsed.timestamp, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.component, 'test-component');
    assert.equal(parsed.message, 'something happened');
    assert.equal(parsed.userId, 'u1');
    assert.equal(parsed.count, 3);
  } finally {
    delete process.env.LOG_FORMAT;
  }
});

test('logger: works with no fields argument at all', async () => {
  delete process.env.LOG_FORMAT;
  try {
    const lines = await captureConsole(() => {
      log.info('test-component', 'no fields here');
    });
    assert.equal(lines.log.length, 1);
    assert.match(lines.log[0], /no fields here/);
  } finally {
    delete process.env.LOG_FORMAT;
  }
});
