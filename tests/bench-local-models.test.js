import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stats } from '../scripts/bench-local-models.js';

test('benchmark stats: correlation, bias and mean absolute error against the reference scores', () => {
  assert.deepEqual(stats([]), { n: 0 });
  assert.deepEqual(stats([[80, 70], [90, 80], [60, 50]]), { n: 3, correlation: 1, bias: 10, mae: 10 });
  assert.equal(stats([[50, 50], [50, 60]]).correlation, null);
});
