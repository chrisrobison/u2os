// Package capability implementations (docs/plugin-architecture.md §7).
//
//   fixture  JSON data from a package file, shaped by an `output` template
//   static   an `output` template over the input
//   module   an ES module export from src/ -- requires the owner to grant
//            code.execute, and runs in-process (not sandboxed)
//
// fixture and static run no package code at all.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveTemplate } from './expression.js';
import { resolveInside } from './package-files.js';

const MAX_FIXTURE_BYTES = 1024 * 1024;

/** Returns execute(input, runtimeContext) for a capability definition. */
export function buildProvider(definition, { packageId, packageDir, invoker }) {
  const implementation = definition.implementation;
  if (implementation.type === 'static') {
    return async (input) => resolveTemplate(implementation.output, { input });
  }
  if (implementation.type === 'fixture') {
    const file = resolveInside(packageDir, implementation.file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) throw new Error(`${definition.id}: fixture must be a regular file up to 1 MiB`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return async (input) => resolveTemplate(implementation.output, { input, data: structuredClone(data) });
  }
  return moduleExecutor({ packageId, packageDir, implementation, invoker, label: definition.id });
}

/** Loads a module export lazily, after re-checking the code.execute grant. */
export function moduleExecutor({ packageId, packageDir, implementation, invoker, label }) {
  let loaded = null;
  return async (input, runtimeContext = {}) => {
    const permission = invoker.permissionFor(packageId, { requiredPermissions: ['code.execute'] });
    if (!permission.allowed) {
      const error = new Error(`${label}: package code is not permitted (code.execute ${permission.reason || 'not granted'})`);
      error.code = 'CODE_NOT_PERMITTED';
      throw error;
    }
    if (!loaded) {
      const file = resolveInside(packageDir, implementation.module);
      const module = await import(pathToFileURL(file).href);
      const fn = module[implementation.export];
      if (typeof fn !== 'function') throw new Error(`${label}: ${implementation.module} does not export ${implementation.export}()`);
      loaded = fn;
    }
    return loaded(structuredClone(input), { ...invoker.providerContext(packageId, runtimeContext), idempotencyKey: runtimeContext.idempotencyKey || null });
  };
}

