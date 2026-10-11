import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJobs, needsOwner } from '../public/components/job-hunt/leads-filter.js';

// The "Needs you" filter on Job Leads (#547).

const job = (id, score, extra = {}) => ({ id, status: 'scored', score: { score }, draft: null, ...extra });

test('a form job whose status is needs_input needs the owner although it has no email draft', () => {
  assert.equal(needsOwner(job('a', 90, { status: 'needs_input' })), true);
});

test('an email draft with unanswered asks needs the owner whatever the status', () => {
  assert.equal(needsOwner(job('a', 70, { draft: { needsInput: ['Visa status'] } })), true);
});

test('ordinary jobs, and drafts with no asks, do not', () => {
  assert.equal(needsOwner(job('a', 90)), false);
  assert.equal(needsOwner(job('a', 90, { draft: { needsInput: [] } })), false);
  assert.equal(needsOwner(job('a', 90, { status: 'contacted' })), false);
});

test('jobs ranked beyond the list limit are merged in once, in score order', () => {
  const ranked = [job('top', 95), job('mid', 80)];
  const waiting = [job('mid', 80, { status: 'needs_input' }), job('deep', 72, { status: 'needs_input' })];
  const merged = mergeJobs(ranked, waiting);
  assert.deepEqual(merged.map((j) => j.id), ['top', 'mid', 'deep']);
  assert.equal(merged.find((j) => j.id === 'mid').status, 'scored', 'the ranked copy is kept');
});

test('nothing extra leaves the list untouched', () => {
  const ranked = [job('a', 90)];
  assert.equal(mergeJobs(ranked, []), ranked);
  assert.equal(mergeJobs(ranked, [job('a', 90)]), ranked);
});
