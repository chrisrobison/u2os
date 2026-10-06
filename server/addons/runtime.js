// Turns the enabled add-ons into MCP server specs for the existing MCP starter
// (server/mcp/mcp-tools.js), so an add-on's tools behave exactly like tools
// from the vault's mcp.yaml: planner-visible as <server>.<tool>, gated by
// policies.yaml, durable queue and audit, results untrusted and privacy
// classified. The only difference is where the decisions come from: a tool the
// owner has not confirmed in addons.yaml is a confirm-required action with
// private results, whatever the manifest suggests.
import { getVaultDir } from '../vault/vault-dir.js';
import { U2OS_ROOT } from '../mcp/config.js';
import { loadAddonDecisions } from './decisions.js';
import { describeAddons, discoverAddons } from './registry.js';

export function loadAddonServerSpecs({ vaultDir = getVaultDir(), discovered = discoverAddons(), decisions = loadAddonDecisions(vaultDir) } = {}) {
  if (decisions.error) return [];
  const view = describeAddons({ discovered, decisions });
  const specs = [];
  for (const addon of view.addons) {
    if (!addon.enabled) continue;
    const entry = discovered.find((candidate) => candidate.id === addon.id && candidate.manifest);
    if (!entry) continue;
    const values = Object.fromEntries(addon.settings.map((setting) => [setting.key, setting.value]));
    const expand = (text) => String(text)
      .replaceAll('${ADDON_DIR}', entry.dir).replaceAll('${VAULT}', vaultDir).replaceAll('${U2OS_ROOT}', U2OS_ROOT)
      .replace(/\$\{setting\.([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key) => (values[key] === undefined || values[key] === null ? '' : String(values[key])));
    for (const server of addon.servers) {
      const manifestServer = entry.manifest.servers.find((candidate) => candidate.name === server.name);
      specs.push({
        name: server.name,
        addonId: addon.id,
        enabled: true,
        command: expand(manifestServer.command),
        args: manifestServer.args.map(expand),
        env: Object.fromEntries(Object.entries(manifestServer.env).map(([key, value]) => [key, expand(value)])),
        timeoutMs: manifestServer.timeoutSeconds * 1000,
        tools: server.tools.map((tool) => ({ name: tool.name, remote: tool.remote, fixed: tool.fixed, description: tool.description, read: tool.effective.read, classification: tool.effective.classification })),
      });
    }
  }
  return specs;
}
