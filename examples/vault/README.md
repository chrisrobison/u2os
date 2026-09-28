# Example vault: Job Hunter

A small, fictional vault (Sam Rivera) showing U2OS's extension model from
[ADR 0009](../../docs/adr/0009-extension-model-mcp-tools-vault-skills-routines.md):
Job Hunter as a **routine**, a **skill** and the **job-hunt MCP server**
instead of a package workflow. The full guide is [docs/job-hunt.md](../../docs/job-hunt.md).

- `me.md`: the job preferences the skill reads
- `skills/job-hunting.md`: how to evaluate postings, apply, and report
- `routines/job-hunter.md`: when to run and what to do, using the skill
- `job-hunt/profile.md`: what may be sent to employers, the boards to search, and whether to submit
- `mcp.yaml`: starts the job-hunt server and lists its tools
- `policies.yaml`: applying needs your confirmation; skipping a job does not

To try it, **copy** the files into your own vault (U2OS writes into a vault,
so don't point `U2OS_VAULT` at this folder), then follow the guide.
