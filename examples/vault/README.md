# Example vault: Job Hunter as a routine and a skill

A small, fictional vault (Sam Rivera) showing U2OS's extension model from
[ADR 0009](../../docs/adr/0009-extension-model-mcp-tools-vault-skills-routines.md):
Job Hunter written as one **routine** and one **skill** instead of a package
workflow. Compare with the reference package in `packages/job-hunter` in
[skills vs packages](../../docs/skills-vs-packages.md).

- `me.md`: the job preferences the skill reads (fictional)
- `skills/job-hunting.md`: how to evaluate postings and what to report
- `routines/job-hunter.md`: when to run and what to do, using the skill

To try it, **copy** the files into your own vault (U2OS writes into a vault,
so don't point `U2OS_VAULT` at this folder):

```sh
cp -r examples/vault/skills examples/vault/routines ~/.u2os-demo/vault/
```

Put your own preferences in your `me.md`, set `enabled: true` in the routine,
and connect web search and notifications. It needs a configured model; the
built-in demo planner does not understand this instruction.
