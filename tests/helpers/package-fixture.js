// Shared fixture for package platform tests: an isolated U2OS_HOME in demo
// mode, a real Agent (gate, policy engine, queue) with fixed policies, the
// platform registries with core capabilities, and a capability invoker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../../server/db/connection.js';
import { EventBus } from '../../server/events/event-bus.js';
import { PolicyEngine } from '../../server/policy/policy-engine.js';
import { createToolRegistry } from '../../server/tools/register-all.js';
import { MockModelProvider } from '../../server/agent/mock-model-provider.js';
import { Agent } from '../../server/agent/agent.js';
import { ensureInstallationMode } from '../../server/seed/installation-mode.js';
import { PlatformRegistries } from '../../server/packages/registries.js';
import { registerCoreCapabilities } from '../../server/packages/core-capabilities.js';
import { CapabilityInvoker } from '../../server/packages/invoker.js';
import { validateManifest, validateCapabilityDefinition, validateSkillDefinition, validateAutomationDefinition } from '../../server/packages/manifest.js';
import { buildProvider } from '../../server/packages/providers.js';
import { upsertPackage, grantPermissions } from '../../server/packages/store.js';

export const DEFAULT_POLICIES = {
  web: { search: 'always' },
  email: { send: 'confirm' },
  mock: { 'email-send': 'autonomous', 'always-denied': 'never', 'needs-confirm': 'confirm' },
  demo: { write: 'autonomous', 'send-note': 'autonomous' },
};

export function createPackageFixture({ policies = DEFAULT_POLICIES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-packages-'));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  const db = getDb();
  const eventBus = new EventBus(db);
  const toolRegistry = createToolRegistry();
  const agent = new Agent({ modelProvider: new MockModelProvider(), policyEngine: new PolicyEngine({ policies }), toolRegistry, eventBus });
  const registries = new PlatformRegistries();
  registerCoreCapabilities(registries.capabilities, toolRegistry, { manifests: [] });
  const invoker = new CapabilityInvoker({ registries, gate: agent });

  /**
   * install({ manifest, capabilities, skills, automations, files, grant })
   * Writes `files` into a package directory, validates everything like the
   * loader does, persists the package row and registers the bundle.
   */
  function install({ manifest: raw, capabilities = {}, skills = {}, automations = {}, workflows = {}, files = {}, grant = 'all' }) {
    const manifest = validateManifest(raw);
    const packageDir = path.join(dir, 'fixture-packages', manifest.id);
    fs.mkdirSync(packageDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(packageDir, name)), { recursive: true });
      fs.writeFileSync(path.join(packageDir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    const policyNames = Object.keys(manifest.policies);
    const emits = manifest.events.emits;
    const loadWorkflow = (file) => { if (!workflows[file]) throw new Error(`missing ${file}`); return workflows[file]; };
    const capabilityDefs = manifest.exports.capabilities.map(({ id }) => validateCapabilityDefinition(capabilities[id], { id, version: manifest.version }));
    const skillDefs = manifest.exports.skills.map(({ id }) => validateSkillDefinition(skills[id], { id, version: manifest.version, policies: policyNames, emits, loadWorkflow }));
    const automationDefs = manifest.exports.automations.map(({ id }) => validateAutomationDefinition(automations[id], { id, policies: policyNames, emits, loadWorkflow }));
    upsertPackage({ manifest, sourceType: 'test', installPath: packageDir });
    const providers = {};
    for (const definition of capabilityDefs) providers[definition.id] = buildProvider(definition, { packageId: manifest.id, packageDir, invoker });
    registries.registerBundle({ manifest, capabilities: capabilityDefs, skills: skillDefs, automations: automationDefs, providers, installPath: packageDir });
    invoker.syncTools();
    if (grant === 'all' && manifest.permissions.length) grantPermissions(manifest.id, manifest.permissions);
    else if (Array.isArray(grant) && grant.length) grantPermissions(manifest.id, grant);
    return { manifest, packageDir };
  }

  async function cleanup() {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { dir, db, eventBus, agent, toolRegistry, registries, invoker, install, cleanup };
}

export function packageManifest(id, overrides = {}) {
  return {
    apiVersion: 'u2os/v1',
    kind: 'Package',
    metadata: { id, name: id, version: '1.0.0' },
    ...overrides,
  };
}
