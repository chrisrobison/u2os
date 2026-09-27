# 0008 — Packages of capabilities, skills and automations

## Status

Accepted; partially superseded by [0009](0009-extension-model-mcp-tools-vault-skills-routines.md). Packaging, permissions, the single gate, tighten-only package policy and audit stand. The declarative workflow language for skills and automations is frozen and will be retired in favour of MCP tools, vault skills and routines.

## Context

Adding behaviour to U2OS meant changing core: tools are hard-coded, connectors are statically imported, the trigger engine has a fixed action set, and routines express intent in natural language for a model to plan. A different use case (job hunting, a server watchdog, an energy manager) therefore required core changes, and nothing could be reviewed, permissioned or removed as a unit.

The runtime already has most of the machinery such behaviour needs: tool contracts, provider selection per domain, a deterministic policy engine, a single action gate with a durable queue, an append-only event log and an audit table.

## Decision

1. **Three composable concepts.** A *capability* is a versioned primitive contract with typed input/output and required permissions, implemented by providers. A *skill* is short-lived reusable behaviour composed of capabilities and other skills. An *automation* is a durable, triggered, stateful workflow. Dependencies point downward only.
2. **Packages are the unit of extension.** A package is a directory with a strictly validated `u2os.yaml` manifest that exports capabilities, skills and automations, declares dependencies with semantic-version ranges, permissions, policies, settings, secret names and emitted events. Installing a package runs no package code.
3. **Existing tools are the core capabilities.** Every `Tool` is registered as a capability under its existing id, and connectors are its providers. Nothing is renamed.
4. **One gate.** Every capability invocation from a package goes through `Agent.evaluateAndMaybeExecute()` with an additive package-authority overlay: permissions (declared ∩ owner-granted) and package policy can block or require approval but never loosen `policies.yaml`. Package capabilities are hidden from the planner.
5. **Deterministic workflows.** Skills and automations are declarative step lists interpreted by a small engine. Expressions are parsed and interpreted as data; there is no `eval`. Code-backed implementations require an explicit `code.execute` grant.
6. **Durability through structured state.** Workflow runs, steps, waits and automation state are persisted as data, checkpointed per step, leased, and deduplicated per trigger slot.
7. **One audit trail.** Package invocations are recorded in `agent_actions` with a `package_context` naming package, automation, run, step, permission and policy decision.

## Consequences

- New behaviour ships as packages without core changes; the reference Job Hunter package proves the composition.
- Package code in `module` implementations runs in-process and is only as trustworthy as its author; isolation is future work and the grant makes that trust explicit.
- Routines, system triggers and goals remain. Moving them onto automations is possible later but not required.
- The word "skill" now means reusable behaviour. The existing `skills/*/manifest.json` files are connector (provider) manifests and keep their location for compatibility.

See [the plugin architecture](../plugin-architecture.md) and [#376](https://github.com/chrisrobison/u2os/issues/376).
