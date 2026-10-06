# 0010 — Lean core with bundled add-ons

## Status

Accepted; implementation in progress (see Implementation status). Extends [0008](0008-packages-capabilities-skills-automations.md) and [0009](0009-extension-model-mcp-tools-vault-skills-routines.md); supersedes neither.

## Context

U2OS is a long-running process that tracks one person's life. People's lives differ: a stay-at-home parent needs calendar, family and school tools but not GitHub; a programmer may want GitHub and a baby monitor. A core that carries every feature fits nobody and grows without bound.

Today:

- MCP servers are declared as a bare entry in the vault's `mcp.yaml`, with no home for a description, README, version, author or assets.
- Email, calendar, contacts and tasks are built into the core.
- Packages already have the right shape (manifest, README, skills, permissions) but are centred on the frozen workflow language.

## Decision

1. **The core is an orchestrator.** It keeps only: the vault and indexer, the gate (planner, policy, durable queue, audit), the scheduler and routines, the event log, the model router and data-processing policy, authentication, and the UI shell. Everything that acts on the world is an add-on.
2. **A package is the unit of installation and the home of an add-on's metadata.** A package is a folder with a manifest, README and assets. An MCP server is something a package contains, together with its tools, skills and starter routines. There is no separate registration file for a package's tools.
3. **Two trust tiers behind one contract.**
   - *Bundled* (first-party, shipped and reviewed with the core) may run in process, as an internal method call.
   - *Installed* (third-party) always runs out of process, as an external command (ADR 0009, point 4).
   The core calls both through the same interface, so an add-on can move between tiers without core changes. The install step, not the package, decides whether in-process execution is allowed.
4. **Packages describe; the vault decides.** Names, descriptions, tools, suggested classifications and setting schemas are derived from installed package manifests. Owner decisions are not: which add-ons are enabled, granted permissions, `policies.yaml` and setting values remain owner-authored vault files (ADR 0007, #401). A package's claim that a tool is read-only or public is a suggested default shown at install, and takes effect only when the owner confirms it.
5. **Defaults ship as bundled add-ons, disabled until granted:** email, calendar, contacts, web search and fetch, notifications, reminders and tasks, notes, and scoped file access. Add-ons such as GitHub, job-hunt, coding agents and device integrations are optional.
6. **Migrate by conforming, not rewriting.** Existing built-ins are made to implement the add-on contract with identical behaviour, one at a time, calendar first. Reserved built-in names (`email`, `calendar`, `web`, and so on) stay protected so an installed package can never inherit a built-in's policy.
7. **UI contribution.** An add-on may contribute navigation entries and pages to the shell through the same manifest. Navigation is grouped so a lean instance stays navigable.

## Consequences

- Each instance is unique to its owner, and the core does not change to support a new kind of life. If it must, the contract is wrong.
- The security properties of ADR 0003, 0006 and 0009 are unchanged: one gate, deny by default, results are untrusted, arguments pass the data-processing policy.
- Migrating built-ins touches code with many tests and policies keyed by domain name. Behaviour-preserving, one-at-a-time migration with the existing suites as the safety net is required.
- Package metadata and the owner's vault files can disagree (a tool removed upstream, a new tool added). The vault wins and unknown tools stay hidden until the owner lists them, as today.
- This is not a language decision. A rewrite of any part of the core is a separate question that should wait for a stable contract and evidence of need.

## Implementation status

- Navigation is grouped into collapsible categories (point 7), shipped in [#435](https://github.com/chrisrobison/u2os/issues/435). Add-ons cannot yet contribute entries through a manifest.
- Package metadata for MCP servers, the bundled/installed trust tiers and migrating built-ins are not yet implemented. Migration starts with calendar in [#453](https://github.com/chrisrobison/u2os/issues/453).

Decided in [#440](https://github.com/chrisrobison/u2os/issues/440), alongside [#401](https://github.com/chrisrobison/u2os/issues/401) and [#402](https://github.com/chrisrobison/u2os/issues/402).
