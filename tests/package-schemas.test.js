import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, checkSchema, applyDefaults } from '../server/packages/json-schema.js';
import { satisfies, compareVersions, isValidRange } from '../server/packages/semver.js';
import { evaluate, resolveTemplate, checkExpression, checkTemplate } from '../server/packages/expression.js';
import { normalizePermissions, checkPermissions, covers } from '../server/packages/permissions.js';
import { evaluatePackagePolicy, validatePolicies } from '../server/packages/policy.js';
import { emitProblem } from '../server/packages/events.js';
import { validateWorkflow, workflowReferences, parseDuration } from '../server/packages/workflow.js';
import { nextCronTime, isValidCron } from '../server/packages/cron.js';
import { defaultTriggerRegistry } from '../server/packages/triggers.js';
import { parseRef } from '../server/packages/ids.js';
import {
  validateManifest, parseYaml, safeRelativePath, ManifestError,
  validateCapabilityDefinition, validateSkillDefinition, validateAutomationDefinition,
} from '../server/packages/manifest.js';

const baseManifest = () => ({
  apiVersion: 'u2os/v1',
  kind: 'Package',
  metadata: { id: 'com.example.demo', name: 'Demo', version: '0.1.0', description: 'A demo.' },
  requires: { u2os: '>=0.1.0', capabilities: { 'web.search': '>=1.0' }, skills: ['company-research'] },
  exports: { automations: [{ id: 'demo', entrypoint: 'automations/demo.yaml' }] },
  permissions: { network: true, email: { read: true, send: true }, filesystem: { read: ['profile.resume'], write: ['jobs.*'] } },
  policies: { autoApply: { all: ['job.score >= settings.threshold'], approval: 'automatic' } },
  settings: { threshold: { type: 'number', default: 85 } },
  secrets: ['gmail.oauth'],
  events: { emits: ['job.candidate'] },
});

test('a valid manifest is normalized', () => {
  const manifest = validateManifest(baseManifest());
  assert.equal(manifest.id, 'com.example.demo');
  assert.deepEqual(manifest.requires.capabilities, { 'web.search': '>=1.0' });
  assert.deepEqual(manifest.requires.skills, { 'company-research': '*' });
  assert.deepEqual(manifest.exports.automations, [{ id: 'demo', file: 'automations/demo.yaml' }]);
  assert.deepEqual(manifest.permissions, ['email.read', 'email.send', 'filesystem.read:profile.resume', 'filesystem.write:jobs.*', 'network']);
});

test('malformed manifests are rejected with every problem listed', () => {
  const raw = baseManifest();
  raw.apiVersion = 'u2os/v0';
  raw.metadata.id = 'Not A Package';
  raw.metadata.version = 'one';
  raw.surprise = true;
  raw.permissions.email.teleport = true;
  raw.permissions.filesystem.read = ['../../etc/passwd'];
  raw.exports.automations[0].entrypoint = '../outside.yaml';
  raw.events.emits = ['email.received', 'job.candidate'];
  raw.settings.token = { type: 'secret' };
  raw.requires.capabilities['web.search'] = 'banana';
  assert.throws(() => validateManifest(raw), (error) => {
    assert.ok(error instanceof ManifestError);
    for (const fragment of ['apiVersion', 'metadata.id', 'metadata.version', 'surprise', 'email.teleport', '../../etc/passwd',
      'exports.automations[0].file', 'reserved core event domain', 'settings.token.type', 'invalid version range']) {
      assert.ok(error.errors.some((message) => message.includes(fragment)), `missing error for ${fragment}: ${error.errors.join(' | ')}`);
    }
    return true;
  });
  assert.throws(() => validateManifest(null), ManifestError);
  assert.throws(() => validateManifest([]), ManifestError);
});

test('YAML is parsed with the safe core schema', () => {
  assert.deepEqual(parseYaml('a: 1\nb: [x]'), { a: 1, b: ['x'] });
  assert.throws(() => parseYaml('a: !!js/function "function () {}"'), ManifestError);
  assert.throws(() => parseYaml('a: [unclosed'), ManifestError);
});

test('package paths cannot escape the package', () => {
  assert.equal(safeRelativePath('workflows/a.yaml'), 'workflows/a.yaml');
  for (const bad of ['/etc/passwd', '../x.yaml', 'a/../../x', 'a\\b', '.hidden/x', 'a//b', '', 'a/./b', 42]) {
    assert.equal(safeRelativePath(bad), null, String(bad));
  }
});

test('JSON schema subset validates and rejects unsupported keywords', () => {
  const schema = { type: 'object', required: ['title'], additionalProperties: false,
    properties: { title: { type: 'string', minLength: 1 }, score: { type: 'number', minimum: 0, maximum: 100 }, tags: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(validate(schema, { title: 'x', score: 5, tags: ['a'] }), []);
  const errors = validate(schema, { score: 500, tags: [1], extra: true });
  assert.ok(errors.some((e) => e.includes('title: is required')));
  assert.ok(errors.some((e) => e.includes('score: must be <= 100')));
  assert.ok(errors.some((e) => e.includes('tags[0]: expected string')));
  assert.ok(errors.some((e) => e.includes('extra: is not allowed')));
  assert.ok(checkSchema({ type: 'string', pattern: '(a+)+$' }).some((e) => e.includes('unsupported keyword "pattern"')));
  assert.ok(checkSchema({ type: 'banana' }).length);
  assert.deepEqual(applyDefaults({ properties: { a: { default: 1 }, b: {} } }, { b: 2 }), { a: 1, b: 2 });
});

test('semantic version ranges', () => {
  assert.ok(satisfies('1.4.2', '^1.0'));
  assert.ok(!satisfies('2.0.0', '^1.0'));
  assert.ok(satisfies('0.1.5', '^0.1.0'));
  assert.ok(!satisfies('0.2.0', '^0.1.0'));
  assert.ok(satisfies('1.2.9', '~1.2'));
  assert.ok(!satisfies('1.3.0', '~1.2'));
  assert.ok(satisfies('1.5.0', '>=1.0 <2.0'));
  assert.ok(satisfies('1.0.0', '*'));
  assert.ok(satisfies('1.9.0', '1'));
  assert.ok(!satisfies('1.0.0-beta', '>=1.0.0'));
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.ok(!isValidRange('>= banana'));
  assert.ok(!satisfies('not-a-version', '*'));
});

test('expressions evaluate over data and support the documented operators', () => {
  const scope = { job: { score: 90, salary: 180000, location: 'Remote', tags: ['a', 'b'] }, prefs: { allowed: ['Remote', 'SF'] } };
  assert.equal(evaluate('job.score >= 85 && job.salary >= 170000', scope), true);
  assert.equal(evaluate('job.location in prefs.allowed', scope), true);
  assert.equal(evaluate('job.location not in prefs.allowed', scope), false);
  assert.equal(evaluate('not (job.score > 95) and len(job.tags) == 2', scope), true);
  assert.equal(evaluate('job.score > 80 ? "high" : "low"', scope), 'high');
  assert.equal(evaluate('job.score * 2 - 10 / 2 + 1 % 1', scope), 175);
  assert.equal(evaluate('job.missing.deeper', scope), undefined);
  assert.equal(evaluate('contains(job.location, "rem")', scope), true);
  assert.equal(evaluate('max(1, 5, 3) + min([4, 2])', scope), 7);
  assert.equal(evaluate('daysSince("2026-01-01T00:00:00Z")', {}, { now: '2026-01-11T00:00:00Z' }), 10);
  assert.equal(evaluate('"a" + 1', {}), 'a1');
  assert.equal(evaluate('1 / 0', {}), null);
  assert.equal(evaluate('job["score"]', scope), 90);
  assert.deepEqual(evaluate('slice(unique(concat(seen, pluck(jobs, "id"))), -3)', { seen: ['a', 'b'], jobs: [{ id: 'b' }, { id: 'c' }, { id: 'd' }] }), ['b', 'c', 'd']);
  assert.throws(() => evaluate('pluck(jobs, "__proto__")', { jobs: [{}] }), /not allowed/);
});

test('expressions cannot reach code, prototypes or methods', () => {
  for (const source of ['constructor', 'job.constructor', 'job["__proto__"]', 'job.__proto__', 'x.prototype']) {
    assert.throws(() => evaluate(source, { job: {}, x: {} }), /not allowed/, source);
  }
  for (const source of ['job.toString()', 'eval("1")', 'Function("return 1")()', 'require("fs")', 'process.exit()', 'a = 1', 'x; y', '`t`']) {
    assert.ok(checkExpression(source), `${source} should be rejected`);
  }
  // Inherited properties are invisible, so a string's methods are unreachable.
  assert.equal(evaluate('s.toUpperCase', { s: 'x' }), undefined);
  assert.equal(evaluate('o.hasOwnProperty', { o: {} }), undefined);
  assert.ok(checkExpression('a'.repeat(3000)));
  assert.ok(checkExpression('('.repeat(200) + '1' + ')'.repeat(200)));
});

test('templates interpolate raw values or text', () => {
  const scope = { inputs: { q: 'engineer', n: 3 }, steps: { a: { output: [1, 2] } } };
  assert.deepEqual(resolveTemplate('{{ steps.a.output }}', scope), [1, 2]);
  assert.equal(resolveTemplate('Find {{ inputs.q }} x{{ inputs.n }}', scope), 'Find engineer x3');
  assert.deepEqual(resolveTemplate({ query: '{{ inputs.q }}', nested: ['{{ inputs.n }}'] }, scope), { query: 'engineer', nested: [3] });
  assert.equal(resolveTemplate('{{ inputs.q }} and {{ inputs.n }}', scope), 'engineer and 3');
  assert.ok(checkTemplate({ a: '{{ bad( }}' }).length);
  assert.ok(checkTemplate('{{ unclosed').length);
});

test('permissions are normalized, and must be both declared and granted', () => {
  const { permissions, errors } = normalizePermissions({ network: { allowed: true }, browser: { navigate: true, submitForms: false }, camera: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(permissions, ['browser.navigate', 'camera', 'network']);
  assert.ok(normalizePermissions({ network: { allowed: true, hosts: ['x'] } }).errors.length);
  assert.ok(normalizePermissions({ teleport: true }).errors.length);
  assert.ok(covers('filesystem.write:jobs.*', 'filesystem.write:jobs.acme'));
  assert.ok(!covers('filesystem.write:jobs.*', 'filesystem.read:jobs.acme'));
  assert.ok(!covers('filesystem.write:jobs.*', 'filesystem.write:jobsx'));
  assert.deepEqual(checkPermissions({ required: ['email.send'], declared: ['email.send'], granted: [] }),
    { allowed: false, required: ['email.send'], missingDeclared: [], missingGrant: ['email.send'] });
  assert.equal(checkPermissions({ required: ['email.send'], declared: [], granted: ['email.send'] }).allowed, false);
  assert.equal(checkPermissions({ required: ['network'], declared: ['network'], granted: ['network'] }).allowed, true);
});

test('package policies are deterministic and fail closed', () => {
  const policies = {
    autoApply: { all: ['job.score >= settings.threshold', 'job.location in settings.allowed'], approval: 'automatic' },
    negotiate: { approval: 'required' },
    never: { approval: 'never' },
    broken: { all: ['job.x.y.z > 1 / 0'] },
  };
  assert.deepEqual(validatePolicies(policies), []);
  const facts = { job: { score: 90, location: 'Remote' }, settings: { threshold: 85, allowed: ['Remote'] } };
  assert.equal(evaluatePackagePolicy('autoApply', policies.autoApply, facts).decision, 'automatic');
  const denied = evaluatePackagePolicy('autoApply', policies.autoApply, { ...facts, job: { score: 50, location: 'Remote' } });
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.reasons.some((reason) => reason.includes('job.score >= settings.threshold')));
  assert.equal(evaluatePackagePolicy('negotiate', policies.negotiate, facts).decision, 'approval');
  assert.equal(evaluatePackagePolicy('never', policies.never, facts).decision, 'deny');
  assert.equal(evaluatePackagePolicy('broken', policies.broken, facts).decision, 'deny');
  assert.equal(evaluatePackagePolicy('missing', undefined, facts).decision, 'deny');
  // The owner can tighten (or relax, within policies.yaml) the approval mode.
  assert.equal(evaluatePackagePolicy('autoApply', policies.autoApply, facts, { approvalOverride: 'required' }).decision, 'approval');
  assert.ok(validatePolicies({ bad: { approval: 'yolo', all: 'x' } }).length >= 2);
});

test('packages may only emit declared, non-reserved event types', () => {
  assert.equal(emitProblem('job.candidate', ['job.candidate']), null);
  assert.match(emitProblem('job.other', ['job.candidate']), /not declared/);
  assert.match(emitProblem('email.received', ['email.received']), /reserved/);
  assert.match(emitProblem('agent.action.completed', ['agent.action.completed']), /reserved/);
  assert.match(emitProblem('Bad Type', ['Bad Type']), /not a valid/);
});

test('workflow definitions are validated strictly', () => {
  const workflow = {
    inputs: { query: { type: 'string' } },
    steps: [
      { id: 'discover', use: 'capability:mock.job-search', with: { query: '{{ inputs.query }}' }, retry: { attempts: 3, backoff: '1s' }, timeout: '30s' },
      { id: 'score', foreach: '{{ steps.discover.output.jobs }}', use: 'skill:score-job', with: { job: '{{ item }}' } },
      { id: 'good', use: 'filter', with: { source: '{{ steps.score.output }}', where: 'item.score >= 75' } },
      { id: 'notify', foreach: '{{ steps.good.output }}', use: 'capability:mock.email-send', policy: 'autoApply', with: { to: 'me' } },
      { id: 'tell', use: 'emit', with: { type: 'job.candidate', data: {} } },
      { id: 'remember', use: 'state', with: { set: { last: '{{ now() }}' } } },
    ],
    output: '{{ steps.good.output }}',
  };
  assert.deepEqual(validateWorkflow(workflow, { kind: 'automation', policies: ['autoApply'], emits: ['job.candidate'] }), []);
  assert.deepEqual(workflowReferences(workflow), { capabilities: ['mock.job-search', 'mock.email-send'], skills: ['score-job'] });

  const skillErrors = validateWorkflow(workflow, { kind: 'skill', policies: [], emits: [] });
  assert.ok(skillErrors.some((e) => e.includes('only allowed in automations')));
  assert.ok(skillErrors.some((e) => e.includes('"autoApply" is not defined')));
  assert.ok(skillErrors.some((e) => e.includes('not declared in events.emits')));

  const bad = validateWorkflow({ steps: [
    { id: 'a', use: 'shell:rm' },
    { id: 'a', use: 'transform' },
    { id: 'c', use: 'filter', with: { source: [] } },
    { id: 'd', use: 'transform', with: { value: 1 }, retry: { attempts: 99 }, timeout: '2d', when: 'x ==', onError: 'explode', policy: 'p' },
  ] }, { kind: 'automation', policies: ['p'] });
  for (const fragment of ['steps[0].use', 'duplicate step id', 'with.value: is required', 'with.where: is required', 'retry.attempts', 'timeout', 'when', 'onError', 'only capability steps take a policy']) {
    assert.ok(bad.some((e) => e.includes(fragment)), `missing ${fragment}: ${bad.join(' | ')}`);
  }
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('10 minutes'), null);
});

test('cron schedules and trigger providers', () => {
  assert.ok(isValidCron('0 8 * * 1-5'));
  assert.ok(!isValidCron('61 * * * *'));
  assert.ok(!isValidCron('* * *'));
  const friday = new Date(2026, 8, 25, 9, 0); // Fri 25 Sep 2026 09:00 local
  const next = nextCronTime('0 8 * * mon-fri', friday);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 8);
  assert.equal(nextCronTime('*/15 * * * *', new Date(2026, 0, 1, 10, 7)).getMinutes(), 15);

  const triggers = defaultTriggerRegistry;
  assert.deepEqual(triggers.validate({ type: 'schedule', cron: '0 8 * * 1-5' }), []);
  assert.deepEqual(triggers.validate({ type: 'schedule', every: '1h' }), []);
  assert.deepEqual(triggers.validate({ type: 'event', event: 'mail.received', where: 'event.data.important == true' }), []);
  assert.deepEqual(triggers.validate({ type: 'manual' }), []);
  assert.ok(triggers.validate({ type: 'schedule', every: '5s' }).length);
  assert.ok(triggers.validate({ type: 'watch', interval: '1h' }).some((e) => e.includes('not available')));
  assert.ok(triggers.validate({ type: 'webhook' }).length);
  const event = triggers.get('event');
  assert.ok(event.matches({ type: 'event', event: 'job.found', where: 'event.data.score > 5' }, { type: 'job.found', data: { score: 9 } }));
  assert.ok(!event.matches({ type: 'event', event: 'job.found', where: 'event.data.score > 5' }, { type: 'job.found', data: { score: 1 } }));
  const hourly = triggers.get('schedule').nextRun({ type: 'schedule', every: '1h' }, new Date('2026-01-01T10:30:00Z'));
  assert.equal(hourly.toISOString(), '2026-01-01T11:00:00.000Z');
});

test('capability, skill and automation definitions', () => {
  const capability = validateCapabilityDefinition({
    id: 'mock.job-search', effect: 'read', permissions: ['network'],
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    implementation: { type: 'fixture', file: 'fixtures/jobs.json' },
  }, { id: 'mock.job-search', version: '0.1.0' });
  assert.equal(capability.effect, 'read');
  assert.equal(capability.implementation.output, '{{ data }}');
  assert.throws(() => validateCapabilityDefinition({ id: 'x.y', implementation: { type: 'shell', command: 'rm -rf /' } }, { id: 'x.y', version: '1.0.0' }), ManifestError);
  assert.throws(() => validateCapabilityDefinition({ id: 'x.y', permissions: ['root'], implementation: { type: 'static', output: {} } }, { id: 'x.y', version: '1.0.0' }), /permissions/);
  assert.throws(() => validateCapabilityDefinition({ id: 'x.y', implementation: { type: 'module', module: '../evil.js' } }, { id: 'x.y', version: '1.0.0' }), /under src/);
  // Capability defaults to a consequential effect.
  assert.equal(validateCapabilityDefinition({ id: 'x.y', implementation: { type: 'static', output: { ok: true } } }, { id: 'x.y', version: '1.0.0' }).effect, 'write');

  const skill = validateSkillDefinition({ id: 'score-job', steps: [{ id: 'score', use: 'transform', with: { value: '{{ inputs.job.salary > 100 }}' } }], output: '{{ steps.score.output }}' },
    { id: 'score-job', version: '0.1.0' });
  assert.equal(skill.workflow.steps.length, 1);
  assert.throws(() => validateSkillDefinition({ id: 'x', steps: [], implementation: { type: 'module', module: 'src/x.js' } }, { id: 'x', version: '1.0.0' }), /exactly one/);
  assert.throws(() => validateSkillDefinition({ id: 'x', steps: [{ id: 's', use: 'sleep', with: { duration: '1m' } }] }, { id: 'x', version: '1.0.0' }), /only allowed in automations/);

  const automation = validateAutomationDefinition({
    id: 'demo', triggers: [{ type: 'schedule', cron: '0 8 * * 1-5' }, { type: 'manual' }],
    state: { schema: { type: 'object', properties: { seen: { type: 'array' } } }, initial: { seen: [] } },
    workflow: 'workflows/demo.yaml',
  }, { id: 'demo', loadWorkflow: () => ({ steps: [{ id: 'a', use: 'sleep', with: { duration: '1m' } }] }) });
  assert.equal(automation.concurrency, 'single');
  assert.equal(automation.triggers.length, 2);
  assert.throws(() => validateAutomationDefinition({ id: 'demo', triggers: [{ type: 'watch' }], steps: [{ id: 'a', use: 'transform', with: { value: 1 } }] }, { id: 'demo' }), /not available/);
  assert.throws(() => validateAutomationDefinition({ id: 'demo', workflow: '../x.yaml' }, { id: 'demo', loadWorkflow: () => ({}) }), /package-relative/);
});

test('stable references', () => {
  assert.deepEqual(parseRef('skill:company-research'), { kind: 'skill', id: 'company-research' });
  assert.deepEqual(parseRef('capability:web.search'), { kind: 'capability', id: 'web.search' });
  assert.deepEqual(parseRef('package:com.u2os.job-hunter'), { kind: 'package', id: 'com.u2os.job-hunter' });
  assert.equal(parseRef('skill:../etc'), null);
  assert.equal(parseRef('tool:web.search'), null);
});
