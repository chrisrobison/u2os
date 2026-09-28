# Job Hunter two ways: package workflow vs routine and skill

[ADR 0009](adr/0009-extension-model-mcp-tools-vault-skills-routines.md) moves U2OS extensions from declarative package workflows to MCP tools, vault skills and routines. This page compares the same behaviour built both ways, so the trade-offs are concrete:

- the reference package: [`packages/job-hunter`](../packages/job-hunter/README.md)
- the routine and skill, with the job-hunt MCP server: [`examples/vault`](../examples/vault/README.md) and [the guide](job-hunt.md)

## The two versions

**Package** (371 lines in 9 files, plus 31 lines of fixtures, run by about 1,800 lines of workflow engine, expression interpreter, cron and automation runtime):

```yaml
- id: parts
  use: transform
  with:
    value:
      salary: "{{ inputs.job.salary >= inputs.preferences.minimumSalary ? 40 : 10 }}"
      location: "{{ inputs.job.remote || inputs.job.location in inputs.preferences.allowedLocations ? 30 : 0 }}"
```

**Routine and skill** (34 lines in 2 files, run by the existing routine runner and planner):

```markdown
A strong match fits a target role, pays at least my minimum when a salary is
given (a missing salary is not disqualifying, but say it is missing), is
remote or in one of my locations, and is not in an industry I avoid.
```

## Comparison

| | Package workflow | Routine + skill |
|---|---|---|
| Who can write it | Someone comfortable with a YAML expression language | Anyone who can describe what they want |
| Where it lives | A package directory; settings and grants in SQLite | Your vault, next to `me.md` and `policies.yaml` |
| Judgement ("is this a good fit?") | Hand-coded scoring rules | The model applies your stated criteria and explains itself |
| Preferences | Package settings (`minimumSalary`) | Facts in your `me.md`, shared with everything else U2OS does |
| Safety | One gate, permissions, package policy, audit | The same gate, your `policies.yaml`, audit; sending is approval-gated by default |
| Determinism | Same input, same output | Model output varies; policy still decides every action |
| Exact de-duplication across runs | Yes, via persistent `state.seen` | Yes: the application ledger in your vault (`job-hunt/applications/`) |
| Works with the built-in demo planner | Yes (mock capabilities) | No: needs a configured model |
| Real job search | Mock board only | Greenhouse and Lever boards through the job-hunt MCP server |
| Applying | No | Yes, in a real browser, approval-gated by default |
| Testing | Unit tests over workflow steps | Routine and skill parsing tests; usefulness needs a real-model evaluation (Milestone B) |

## What the routine version still lacks, and how to add it deliberately

- **Exact de-duplication** now comes from the tool rather than the routine: the job-hunt server's ledger leaves applied and skipped jobs out of search and refuses to apply twice. Routines that use no such tool still rely on recent history.
- **Deterministic thresholds.** "Only notify automatically above a score of 85" belongs in policy code over structured facts: ADR 0008's package policy, kept by ADR 0009. The model proposes, and policy decides.
- **Tools beyond the built-ins** come from MCP servers ([MCP tools](mcp.md)), such as the [job-hunt server](job-hunt.md).

The package keeps running unchanged until the routine version reaches parity on these points ([#402](https://github.com/chrisrobison/u2os/issues/402)).
