# 0009 — Extension model: MCP tools, vault skills, routines as automations

## Status

Accepted. Partially supersedes [0008](0008-packages-capabilities-skills-automations.md): its packaging, permission, gate, policy and audit decisions stand; its declarative workflow language for skills and automations is frozen and will be retired.

## Context

ADR 0008 made packages the unit of extension. Its safety core is right and is kept:

- every package action goes through `Agent.evaluateAndMaybeExecute()`
- permissions are declared by the package and granted by the owner, and re-checked at execution
- package policy can only tighten `policies.yaml`
- installing runs no package code
- package capabilities are hidden from the planner
- invocations are audited with `package_context`

Its programming model has four problems for a single-owner system whose premise is a model that understands the owner's intent ([ADR 0007](0007-owned-vault-is-the-digital-self.md)):

1. **It is a programming language.** Skills and automations are YAML step lists with `{{ }}` expressions, `filter`/`transform`/`foreach` and retries, interpreted by a custom expression engine, with hand-written cron, semver and JSON Schema support. Logic written this way is harder to write, test and debug than code, and every new need grows the language.
2. **It adds a fourth way to act unattended.** Routines, system triggers and goals already exist, each with its own triggers, durability and de-duplication.
3. **It sits outside the vault.** Package settings, permission grants and automation state live only in SQLite, although what the owner delegates is part of "what may be done on my behalf".
4. **Code-backed packages run in process** without isolation.

## Decision

1. **Packages stay the unit of installation and permission review.** The manifest, validation, declared ∩ granted permissions, tighten-only package policy, single gate and `package_context` audit from ADR 0008 are unchanged.
2. **Tools come from MCP servers.** New capabilities are provided by [Model Context Protocol](https://modelcontextprotocol.io) servers that a package (or the owner's vault) declares.
   - They run out of process, which gives isolation, any implementation language and an existing ecosystem.
   - Each MCP tool is a capability whose calls go through the gate. The owner's `policies.yaml` classifies it, and an unclassified tool requires confirmation.
   - Tool arguments pass the data-processing policy as an `external_tool` destination, and results are untrusted observations.
   - Built-in tools and connectors are unchanged.
3. **Skills are Markdown instructions in the vault.** A skill (`skills/*.md`) says how the owner wants something done. Routines (and later chat) name the skills they use, and the planner receives the skill text alongside the instruction. There is no step language.
4. **Automations are routines.** Unattended, triggered work is expressed as routines ([routines](../routines.md)): one trigger, durability and de-duplication mechanism. Deterministic conditions over structured facts, like ADR 0008's package policy (`score >= threshold`), stay in policy code where they gate actions. They are added to routines only where real use shows a need.
5. **Owner delegation lives in the vault.** Package permission grants and settings move to vault files next to `policies.yaml`, validated and failing closed.
6. **Freeze.** No new features are added to the declarative workflow engine, expression interpreter or package automation runtime. They keep running the reference package until Job Hunter reaches parity on routines, skills and MCP tools. After that they are removed, and their gate integration, permissions, policy and audit code is kept.

## Consequences

- The model does what the model is good at (interpreting intent and data) and policy code decides what may happen, instead of hand-coding judgement in YAML.
- Isolation for third-party code comes from the process boundary, not from future sandboxing work.
- One mechanism for unattended work. Triggers and goals can later become routines too.
- Routines lack some guarantees that deterministic workflows give, such as exact de-duplication across runs. These are added deliberately, as small structured features, when real use needs them, and the [Job Hunter comparison](../skills-vs-packages.md) documents them.
- Implemented so far: vault skills, MCP servers as gated capability providers, the first-party job-hunt MCP server with its ledger in the vault, and Job Hunter as a routine plus a skill. The `coding.agent` capability ([#428](https://github.com/chrisrobison/u2os/issues/428)) is a built-in capability that launches the official Codex or Claude Code CLI as a subprocess; it follows the same gate and never holds those tools' credentials.
- Migration is tracked in [#397](https://github.com/chrisrobison/u2os/issues/397):
  - vault skills ([#399](https://github.com/chrisrobison/u2os/issues/399))
  - MCP providers ([#400](https://github.com/chrisrobison/u2os/issues/400))
  - grants in the vault ([#401](https://github.com/chrisrobison/u2os/issues/401))
  - packages shipping routines and skills, then retiring the engine ([#402](https://github.com/chrisrobison/u2os/issues/402))
