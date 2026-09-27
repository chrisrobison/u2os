# Skill author guide

A skill is short-lived, reusable behaviour with typed input and output, built from capabilities and other skills: `company-research`, `summarize-thread`, `score-job`. Automations call skills instead of carrying their own copies of that logic.

## A declarative skill

```yaml
# skills/company-research.yaml
id: company-research
version: 1.0.0                 # defaults to the package version
description: Summarize a company and its open roles.
requires:                      # optional; merged with the package's requires
  capabilities: { mock.company-profile: ^1.0, mock.job-search: ^1.0 }
inputSchema:
  type: object
  required: [company]
  properties: { company: { type: string, minLength: 1 } }
outputSchema:
  type: object
  required: [company, openRoles]
steps:
  - id: profile
    use: capability:mock.company-profile
    with: { company: "{{ inputs.company }}" }
    retry: { attempts: 3 }
  - id: board
    use: capability:mock.job-search
    with: { query: "{{ inputs.company }}" }
  - id: openings
    use: filter
    with:
      source: "{{ steps.board.output.jobs }}"
      where: "item.company == inputs.company"
output:
  company: "{{ inputs.company }}"
  openRoles: "{{ len(steps.openings.output) }}"
```

A skill is exactly one of: inline `steps` (with optional `inputs` and `output`), a `workflow: workflows/file.yaml` reference, or a code `implementation`. The workflow language is in the [automation guide](automations.md#workflow-reference); skills may use every step kind except the automation-only `state`, `sleep` and `wait`.

The skill's input is validated against `inputSchema` (after applying defaults), and its result against `outputSchema`. `inputs` in expressions is the skill's input. Without an `output` template, the skill returns the last completed step's output.

## Composition

A step `use: skill:<id>` runs the skill as a child run of the caller. The child is persisted like any run, so a skill that waits (for an owner approval of one of its actions) makes its caller wait too, across restarts. Skills may call skills up to 8 levels deep.

To use a skill from another package, declare it:

```yaml
requires:
  skills:
    company-research: ^1.0
```

### The principal rule

Capability calls made inside a skill act with the permissions of **the package whose automation (or top-level skill run) started the work**, not the skill's own package. An automation cannot borrow another package's grants by calling its skill. That is why the calling package must declare every permission needed by the skills it uses; installation checks this transitively. Settings and package policies inside a skill are the skill's own package's.

Actions inside skills are audited with the skill, its run, the root run and the initiating automation.

## Code-backed skills

When a workflow cannot express the logic:

```yaml
id: parse-listing
implementation:
  type: module
  module: src/parse-listing.js
  export: parseListing
```

`export async function parseListing(input, context)` returns the output. `context` is the same as for [module capabilities](capabilities.md#implementations): `settings`, `getSecret`, and `invoke(capabilityId, input)` (as the skill's own package). The skill's package needs the `code.execute` grant. Prefer declarative skills; they are validated at install, inspectable step by step, resumable, and run no package code.

## Design advice

- Keep skills small, deterministic, and single-purpose. Put reusable domain logic in skills and orchestration in automations.
- Validate input with `inputSchema` rather than defensive expressions.
- A model can produce facts (a score, a classification) through a capability; let policies and filters, evaluated by U2OS, decide what happens with them.
- Skills cannot emit event types their package did not declare, and cannot emit reserved core domains.
