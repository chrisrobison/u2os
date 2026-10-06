import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelFailure } from '../server/agent/model-failure.js';

const net = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('classifyModelFailure maps network causes, HTTP statuses and timeouts', () => {
  assert.equal(classifyModelFailure(net('ECONNREFUSED')).code, 'connection_refused');
  assert.equal(classifyModelFailure(net('ENOTFOUND')).code, 'host_not_found');
  assert.equal(classifyModelFailure(net('EHOSTUNREACH')).code, 'host_unreachable');
  assert.equal(classifyModelFailure(new Error('Model provider timed out')).code, 'timeout');
  assert.equal(classifyModelFailure(new Error('Model provider unavailable (HTTP 401)')).code, 'unauthorized');
  assert.equal(classifyModelFailure(new Error('Model provider unavailable (HTTP 404)')).code, 'not_found');
  assert.equal(classifyModelFailure(new Error('Model provider unavailable (HTTP 502)')).code, 'http_error');
  assert.equal(classifyModelFailure(new Error('Model provider returned invalid JSON')).code, 'invalid_response');
  assert.equal(classifyModelFailure(new Error('anything else with secret sk-123')).code, 'error');
});

test('classifyModelFailure never echoes raw error text', () => {
  const { text } = classifyModelFailure(new Error('Model provider unavailable (HTTP 500): key sk-secret-123 body private text'));
  assert.doesNotMatch(text, /sk-secret|private/);
});
