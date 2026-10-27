import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJobs, needsOwner, sortJobs } from '../public/components/job-hunt/leads-filter.js';

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

// #624: sorting Job Leads.
const row = (id, extra = {}) => ({ id, company: id, role: '', status: 'scored', score: { score: 50 }, firstSeenAt: null, ...extra });
const ids = (jobs) => jobs.map((j) => j.id);

test('score sorts best first by default and reverses', () => {
  const jobs = [row('a', { score: { score: 70 } }), row('b', { score: { score: 90 } }), row('c', { score: null })];
  assert.deepEqual(ids(sortJobs(jobs)), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortJobs(jobs, 'score', 'asc')), ['a', 'b', 'c'], 'a job with no score stays last either way');
});

test('newest sorts by first-seen date, undated jobs last', () => {
  const jobs = [row('old', { firstSeenAt: '2026-01-01T00:00:00Z' }), row('none'), row('new', { firstSeenAt: '2026-10-01T00:00:00Z' })];
  assert.deepEqual(ids(sortJobs(jobs, 'newest')), ['new', 'old', 'none']);
  assert.deepEqual(ids(sortJobs(jobs, 'newest', 'asc')), ['old', 'new', 'none']);
});

test('company and role sort A to Z ignoring case, blanks last, ties keep the incoming order', () => {
  const jobs = [row('1', { company: 'beta', role: 'x' }), row('2', { company: 'Alpha', role: '' }), row('3', { company: 'alpha', role: 'a' }), row('4', { company: '' })];
  assert.deepEqual(ids(sortJobs(jobs, 'company')), ['2', '3', '1', '4']);
  assert.deepEqual(ids(sortJobs(jobs, 'company', 'desc')), ['1', '2', '3', '4']);
  assert.deepEqual(ids(sortJobs(jobs, 'role')), ['3', '1', '2', '4']);
});

test('an unknown sort falls back to score and the input is not mutated', () => {
  const jobs = [row('a', { score: { score: 1 } }), row('b', { score: { score: 2 } })];
  assert.deepEqual(ids(sortJobs(jobs, 'bogus')), ['b', 'a']);
  assert.deepEqual(ids(jobs), ['a', 'b']);
});
