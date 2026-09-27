// Dependency validation (docs/plugin-architecture.md §5). A basic
// semantic-version compatibility check, not a solver: every required
// capability/skill must be exported by the package itself or already
// registered at a compatible version, and every capability/skill a
// package's workflows use must be declared (so the install review shows
// the truth).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from './semver.js';
import { workflowReferences } from './workflow.js';
import { covers } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const U2OS_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;

/**
 * validateDependencies(bundle, registries, { u2osVersion }) -> { errors, resolved }
 * bundle: { manifest, capabilities, skills, automations }
 */
export function validateDependencies(bundle, registries, { u2osVersion = U2OS_VERSION } = {}) {
  const { manifest } = bundle;
  const errors = [];
  const resolved = { capabilities: {}, skills: {} };

  if (manifest.requires.u2os && !satisfies(u2osVersion, manifest.requires.u2os)) {
    errors.push(`requires U2OS ${manifest.requires.u2os}, but this is ${u2osVersion}`);
  }

  const ownCapabilities = new Map(bundle.capabilities.filter((c) => !c.implements).map((c) => [c.id, c.version]));
  const ownSkills = new Map(bundle.skills.map((s) => [s.id, s.version]));

  const required = { capabilities: { ...manifest.requires.capabilities }, skills: { ...manifest.requires.skills } };
  for (const skill of bundle.skills) {
    for (const kind of ['capabilities', 'skills']) {
      for (const [id, range] of Object.entries(skill.requires?.[kind] || {})) required[kind][id] ??= range;
    }
  }

  const check = (kind, id, range, own, registry) => {
    if (own.has(id)) {
      const version = own.get(id);
      if (!satisfies(version, range)) errors.push(`${kind === 'capabilities' ? 'capability' : 'skill'} ${id} is ${version} in this package, but ${range} is required`);
      resolved[kind][id] = { version, source: `package:${manifest.id}` };
      return;
    }
    const existing = kind === 'capabilities' ? (registry.has(id) ? registry.get(id) : null) : registry.find(id);
    if (!existing) { errors.push(`missing ${kind === 'capabilities' ? 'capability' : 'skill'} ${id} (${range})`); return; }
    if (!satisfies(existing.version, range)) {
      errors.push(`incompatible ${kind === 'capabilities' ? 'capability' : 'skill'} ${id}: ${existing.version} is installed, ${range} is required`);
      return;
    }
    resolved[kind][id] = { version: existing.version, source: existing.source || `package:${existing.packageId}` };
  };
  for (const [id, range] of Object.entries(required.capabilities)) check('capabilities', id, range, ownCapabilities, registries.capabilities);
  for (const [id, range] of Object.entries(required.skills)) check('skills', id, range, ownSkills, registries.skills);

  // Providers for another package's contract need that contract.
  for (const capability of bundle.capabilities) {
    if (!capability.implements) continue;
    if (!ownCapabilities.has(capability.implements) && !registries.capabilities.has(capability.implements)) {
      errors.push(`capability ${capability.id} implements unknown capability ${capability.implements}`);
    } else if (registries.capabilities.has(capability.implements) && registries.capabilities.get(capability.implements).source === 'core') {
      errors.push(`capability ${capability.id}: packages cannot yet provide core capability ${capability.implements}`);
    }
  }

  // Everything a workflow uses must be declared or exported.
  const workflows = [
    ...bundle.skills.filter((s) => s.workflow).map((s) => [`skill ${s.id}`, s.workflow]),
    ...bundle.automations.map((a) => [`automation ${a.id}`, a.workflow]),
  ];
  for (const [where, workflow] of workflows) {
    const refs = workflowReferences(workflow);
    for (const id of refs.capabilities) {
      if (!ownCapabilities.has(id) && !(id in required.capabilities)) errors.push(`${where} uses capability ${id}, which is not declared in requires.capabilities`);
    }
    for (const id of refs.skills) {
      if (!ownSkills.has(id) && !(id in required.skills)) errors.push(`${where} uses skill ${id}, which is not declared in requires.skills`);
    }
  }

  // A capability's required permissions must be declared by the package
  // that uses it, or it can never run (the invoker would deny it).
  const used = new Set(Object.keys(required.capabilities));
  for (const [, workflow] of workflows) for (const id of workflowReferences(workflow).capabilities) used.add(id);
  for (const id of used) {
    const contract = bundle.capabilities.find((c) => c.id === id && !c.implements)
      || (registries.capabilities.has(id) ? registries.capabilities.get(id) : null);
    for (const permission of contract?.requiredPermissions || []) {
      if (!manifest.permissions.some((held) => covers(held, permission))) {
        errors.push(`capability ${id} requires permission ${permission}, which the package does not declare`);
      }
    }
  }

  return { errors, resolved };
}
