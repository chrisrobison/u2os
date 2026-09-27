// Wires the package platform into a running U2OS (docs/plugin-architecture.md
// §3): registries with core capabilities, the capability invoker on top of
// the agent's action gate, the workflow engine, the automation runtime and
// the package manager. Installed packages are loaded from disk here; the
// runtime starts with the other background workers after the server binds.
import { PlatformRegistries } from './registries.js';
import { registerCoreCapabilities } from './core-capabilities.js';
import { CapabilityInvoker } from './invoker.js';
import { WorkflowEngine } from './workflow-engine.js';
import { AutomationRuntime } from './automation-runtime.js';
import { PackageManager } from './manager.js';
import { log } from '../logging/logger.js';

export function createPackagePlatform({ agent, eventBus, dataDir, clock } = {}) {
  const registries = new PlatformRegistries();
  registerCoreCapabilities(registries.capabilities, agent.toolRegistry);
  const invoker = new CapabilityInvoker({ registries, gate: agent });
  const engine = new WorkflowEngine({ registries, invoker, eventBus, ...(clock ? { clock } : {}) });
  const runtime = new AutomationRuntime({ registries, engine, eventBus, ...(clock ? { clock } : {}) });
  const manager = new PackageManager({ registries, invoker, runtime, eventBus, dataDir });
  const loaded = manager.loadInstalled();
  if (loaded.failed.length) log.warn('packages', 'Some installed packages could not be loaded', { count: loaded.failed.length });
  return { registries, invoker, engine, runtime, manager };
}
