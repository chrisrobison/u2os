import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// #642: static regression guards for the Job Hunt views. Approval stays the deterministic two-step path in <u2-job-submit>,
// and nothing in the redesigned views can widen what the agent does on its own.

const DIR = join(import.meta.dirname, '..', 'public', 'components', 'job-hunt');
const source = (name) => readFileSync(join(DIR, name), 'utf8');
const files = readdirSync(DIR).filter((name) => name.endsWith('.js'));

test('only the shared submit component calls the approval endpoint, and it sends confirm:true behind a second step', () => {
  const callers = files.filter((name) => /approveAndSubmitJobHuntJob/.test(source(name)));
  assert.deepEqual(callers, ['u2-job-submit.js']);
  const api = readFileSync(join(DIR, '..', '..', 'services', 'api.js'), 'utf8');
  assert.match(api, /approve-and-submit`, 'POST', \{ planHash, confirm: true \}/);
  const submit = source('u2-job-submit.js');
  assert.match(submit, /Yes, submit this application/);
});

test('no job-hunt view writes autopilot settings, runs the autopilot or approves a generic agent action', () => {
  const offenders = files.filter((name) => /\b(setAutopilot|runAutopilot|approveAction|rejectAction)\b/.test(source(name)));
  // The dashboard/leads controls that existed before the redesign own those calls; the redesigned views must not.
  for (const name of ['u2-job-overview.js', 'u2-job-operations.js', 'u2-job-opportunities.js', 'u2-job-detail-panel.js', 'jh-operations-parts.js', 'jh-overview-parts.js', 'jh-opportunities-parts.js', 'jh-detail-parts.js']) {
    assert.ok(!offenders.includes(name), `${name} must not change autopilot or approval state`);
  }
});

test('Agent Operations renders no control that could change a policy or an approval', () => {
  const parts = source('jh-operations-parts.js');
  assert.doesNotMatch(parts, /el\('(button|input|select|form|textarea)'/);
});

test('the opportunities host asks the server for one bounded page and never the whole list', () => {
  const model = source('jh-opportunities-model.js');
  assert.match(model, /PAGE_SIZE\s*=\s*\d+/);
  assert.match(source('u2-job-opportunities.js'), /apiParams\(this\._state, PAGE_SIZE\)/);
});

test('background refreshes keep keyboard focus and a repeated failure is not re-announced', () => {
  for (const name of ['u2-job-overview.js', 'u2-job-operations.js']) {
    const text = source(name);
    assert.match(text, /keepFocus\(/, `${name} keeps focus across refreshes`);
    assert.match(text, /message === this\._error\) return/, `${name} ignores an identical repeated failure`);
  }
});
