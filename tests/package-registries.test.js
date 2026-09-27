import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformRegistries } from '../server/packages/registries.js';
import { registerCoreCapabilities, CORE_CAPABILITY_PERMISSIONS } from '../server/packages/core-capabilities.js';
import { validateDependencies } from '../server/packages/dependencies.js';
import { createToolRegistry } from '../server/tools/register-all.js';

function manifest(id, overrides = {}) {
  return {
    id, name: id, version: '1.0.0', description: '', permissions: [],
    requires: { u2os: null, capabilities: {}, skills: {} },
    exports: { capabilities: [], skills: [], automations: [] },
    policies: {}, settings: {}, secrets: [], events: { emits: [], subscribes: [] }, ui: {},
    ...overrides,
  };
}

function researchBundle(version = '1.2.0') {
  return {
    manifest: manifest('com.example.research', {
      version, permissions: ['network'],
      requires: { u2os: '>=0.1.0', capabilities: { 'web.search': '^1.0' }, skills: {} },
      exports: { capabilities: [], skills: [{ id: 'company-research', file: 'skills/company-research.yaml' }], automations: [] },
    }),
    capabilities: [],
    skills: [{ id: 'company-research', version, requires: { capabilities: {}, skills: {} },
      workflow: { steps: [{ id: 'search', use: 'capability:web.search', with: { query: '{{ inputs.company }}' } }] } }],
    automations: [],
  };
}

function hunterBundle(skillRange = '^1.0') {
  return {
    manifest: manifest('com.example.hunter', {
      permissions: ['network'],
      requires: { u2os: null, capabilities: {}, skills: { 'company-research': skillRange } },
      exports: {
        capabilities: [{ id: 'mock.job-search', file: 'capabilities/search.yaml' }],
        skills: [], automations: [{ id: 'hunter', file: 'automations/hunter.yaml' }],
      },
    }),
    capabilities: [{ id: 'mock.job-search', version: '1.0.0', effect: 'read', requiredPermissions: ['network'], inputSchema: { type: 'object' }, implementation: { type: 'static', output: {} } }],
    skills: [],
    automations: [{ id: 'hunter', triggers: [{ type: 'manual' }], workflow: { steps: [
      { id: 'search', use: 'capability:mock.job-search' },
      { id: 'research', use: 'skill:company-research', with: { company: 'x' } },
    ] } }],
  };
}

function coreRegistries() {
  const registries = new PlatformRegistries();
  registerCoreCapabilities(registries.capabilities, createToolRegistry(), { manifests: [
    { id: 'gmail', provides: ['email.search', 'email.read', 'email.send'] },
    { id: 'imap', provides: ['email.search', 'email.read', 'email.send'] },
  ] });
  return registries;
}

test('every mapped core tool is a capability with its existing id, and connectors are its providers', () => {
  const registries = coreRegistries();
  const send = registries.capabilities.get('email.send');
  assert.equal(send.effect, 'write');
  assert.equal(send.source, 'core');
  assert.deepEqual(send.requiredPermissions, ['email.send']);
  assert.equal(registries.capabilities.get('web.search').effect, 'read');
  const listed = registries.capabilities.list().find((c) => c.id === 'email.send');
  assert.deepEqual(listed.providers[0].connectors, ['gmail', 'imap']);
  assert.equal(listed.selectedProvider, 'core');
  assert.equal(registries.capabilities.list().length, Object.keys(CORE_CAPABILITY_PERMISSIONS).length);
});

test('skills compose from capabilities, and automations from skills across packages', () => {
  const registries = coreRegistries();
  registries.registerBundle(researchBundle());
  registries.registerBundle(hunterBundle());
  assert.equal(registries.skills.get('company-research').packageId, 'com.example.research');
  assert.equal(registries.automations.get('hunter').packageId, 'com.example.hunter');
  assert.equal(registries.capabilities.get('mock.job-search').source, 'package:com.example.hunter');
  assert.equal(registries.capabilities.resolveProvider('mock.job-search').packageId, 'com.example.hunter');
  assert.deepEqual(registries.packages.dependentsOf('com.example.research'), ['com.example.hunter']);
});

test('missing dependencies are rejected', () => {
  const registries = coreRegistries();
  assert.throws(() => registries.registerBundle(hunterBundle()), (error) => {
    assert.equal(error.code, 'PACKAGE_DEPENDENCIES');
    assert.ok(error.errors.some((e) => e.includes('missing skill company-research')));
    return true;
  });
  assert.equal(registries.packages.has('com.example.hunter'), false);
});

test('incompatible versions are rejected', () => {
  const registries = coreRegistries();
  registries.registerBundle(researchBundle('2.0.0'));
  assert.throws(() => registries.registerBundle(hunterBundle('^1.0')), /incompatible skill company-research: 2.0.0 is installed, \^1.0 is required/);
  const incompatibleCore = researchBundle();
  incompatibleCore.manifest.requires.capabilities['web.search'] = '^2.0';
  const errors = validateDependencies(incompatibleCore, coreRegistries()).errors;
  assert.ok(errors.some((e) => e.includes('incompatible capability web.search')));
  const futureCore = researchBundle();
  futureCore.manifest.requires.u2os = '>=9.0.0';
  assert.ok(validateDependencies(futureCore, coreRegistries()).errors.some((e) => e.includes('requires U2OS >=9.0.0')));
});

test('workflows must declare what they use, and packages must declare the permissions it needs', () => {
  const registries = coreRegistries();
  const undeclared = researchBundle();
  undeclared.manifest.requires.capabilities = {};
  undeclared.manifest.permissions = [];
  const errors = validateDependencies(undeclared, registries).errors;
  assert.ok(errors.some((e) => e.includes('uses capability web.search, which is not declared')));
  assert.ok(errors.some((e) => e.includes('requires permission network, which the package does not declare')));
});

test('ids cannot collide across packages, and unregistering removes everything', () => {
  const registries = coreRegistries();
  registries.registerBundle(researchBundle());
  const impostor = researchBundle();
  impostor.manifest = { ...impostor.manifest, id: 'com.example.impostor' };
  assert.throws(() => registries.registerBundle(impostor), /already provided by package com.example.research/);
  const coreClash = hunterBundle();
  coreClash.capabilities[0] = { ...coreClash.capabilities[0], id: 'email.send' };
  assert.ok(registries.check(coreClash).some((e) => e.includes('capability email.send is already provided by core')));
  registries.unregisterPackage('com.example.research');
  assert.equal(registries.skills.has('company-research'), false);
  assert.equal(registries.capabilities.has('web.search'), true);
});

test('a package may provide an alternative implementation of another package\'s capability', () => {
  const registries = coreRegistries();
  registries.registerBundle(researchBundle());
  registries.registerBundle(hunterBundle());
  const alt = {
    manifest: manifest('com.example.alt-search', { permissions: ['network'], exports: { capabilities: [{ id: 'alt.job-search', file: 'c.yaml' }], skills: [], automations: [] } }),
    capabilities: [{ id: 'alt.job-search', implements: 'mock.job-search', version: '1.0.0', effect: 'read', requiredPermissions: ['network'], implementation: { type: 'static', output: {} } }],
    skills: [], automations: [],
  };
  registries.registerBundle(alt);
  assert.deepEqual(registries.capabilities.providers('mock.job-search').map((p) => p.id), ['com.example.hunter', 'com.example.alt-search/alt.job-search']);
  assert.equal(registries.capabilities.resolveProvider('mock.job-search').id, 'com.example.hunter');
  registries.capabilities.select('mock.job-search', 'com.example.alt-search/alt.job-search');
  assert.equal(registries.capabilities.resolveProvider('mock.job-search').packageId, 'com.example.alt-search');
  registries.unregisterPackage('com.example.alt-search');
  assert.equal(registries.capabilities.resolveProvider('mock.job-search').packageId, 'com.example.hunter');

  const coreOverride = { ...alt, manifest: manifest('com.example.mailer', { permissions: ['email.send'] }),
    capabilities: [{ ...alt.capabilities[0], id: 'my.send', implements: 'email.send', requiredPermissions: ['email.send'] }] };
  assert.ok(registries.check(coreOverride).some((e) => e.includes('cannot yet provide core capability email.send')));
});
