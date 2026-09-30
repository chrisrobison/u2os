# Coding agents

U2OS can hand a software-engineering task to a coding agent you already use, such as **OpenAI Codex CLI** or **Anthropic Claude Code**, and report what happened. This is the `coding.agent` capability.

The design rule is that **U2OS never holds your AI credentials**. It launches the provider's official command-line tool as a subprocess. That tool owns sign-in, your subscription, billing, model choice and its own behaviour. U2OS does not read token files, call provider APIs, proxy a subscription, or turn subscription access into API access.

```text
U2OS
 └─ coding.agent capability
     ├─ Codex adapter        → codex exec …      (Codex owns your ChatGPT sign-in)
     └─ Claude Code adapter  → claude -p …       (Claude Code owns your Claude sign-in)
```

A coding agent here means "something that takes a task in a directory and works on it", not "a cloud API". The same abstraction can later front a local model or another harness. Nothing outside an adapter knows which tool is underneath.

## Setup

1. Install and sign in to the tool the normal way. Run it once yourself to confirm it works:
   - Codex: install [Codex CLI](https://github.com/openai/codex), run `codex login` (ChatGPT account), then try `codex`.
   - Claude Code: install [Claude Code](https://docs.claude.com/en/docs/claude-code), sign in with `claude`, then try `claude`.
2. Ask U2OS what it found. No API key is needed or used:

```text
$ npm run u2 -- coding-agent providers
PROVIDER     STATUS     DETAIL
codex        available  codex-cli 0.156.1
claude-code  available  2.1.286 (Claude Code)
```

A provider is "available" when its executable runs `--version`. U2OS does not test that you are signed in; if you are not, the run fails and the tool's own message is in the run record.

## Running a task

```bash
npm run u2 -- coding-agent run --provider auto --cwd ~/projects/example \
  "Inspect the project and explain the architecture."

# a task that changes files and runs tests
npm run u2 -- coding-agent run --provider codex --cwd ~/projects/example \
  --write --shell --git "Fix the failing tests. Do not modify unrelated files."
```

Output streams as it happens. The command ends with the run id and exits `0` (completed), `1` (failed), `2` (needs input) or `130` (cancelled). Ctrl-C cancels the run.

| Option | Meaning |
|---|---|
| `--cwd <dir>` | **Required.** The project directory. |
| `--provider auto\|<id>` | `auto` (default) picks by preference and availability; or name `codex` / `claude-code`. |
| `--preference a,b` | Try these providers in this order, instead of the configured order. |
| `--write` | Allow changes inside the project (`--filesystem project`). |
| `--filesystem none\|read\|project\|unrestricted` | Filesystem level. Default `read`. |
| `--shell`, `--git`, `--network` | Allow commands, git (needs `--shell`), network use. Default off. |
| `--timeout <seconds>` | Stop the run after this long. Default 30 minutes. |
| `--json` | Print the final run as JSON, nothing else. |
| `-` as the task | Read the task from stdin. |

`runs` lists recent runs and `show <run-id>` prints one. `run`, `runs` and `show` are offline commands like the rest of `npm run u2`: they refuse to run while the U2OS server owns the same `U2OS_HOME` ([runtime ownership](runtime-ownership.md)). `providers` can run any time.

## Configuration: `coding-agents.yaml`

Optional, at the top of your [vault](vault.md). With no file, every built-in provider is enabled and looked up on `PATH`.

```yaml
default: codex                         # tried first for provider: auto
preference: [codex, claude-code, local]  # then these, in order; unknown ids are skipped
roots: [~/Projects]                    # optional: a run's cwd must be inside one
timeout_seconds: 1800                  # optional default timeout
providers:
  codex:
    enabled: true
    executable: codex                  # a name on PATH, or a full path
    model: gpt-5.1-codex               # optional; passed to the tool's own --model
  claude-code:
    enabled: true
    executable: /opt/tools/claude
```

- `provider: auto` tries `default`, then `preference`, then any other registered provider, and uses the first that is enabled and available.
- An invalid file **fails closed**: no provider is enabled and the error is shown, rather than guessing.
- The file is read on every call, so edits apply without a restart.
- Provider-specific settings (`executable`, `model`) live here, never in the task.

## Using it from code

```js
import { createCodingAgentService } from './server/coding-agent/index.js';

const service = createCodingAgentService({ eventBus });
const run = await service.run({
  provider: 'auto',                       // or 'codex'
  cwd: '/projects/u2os',
  task: 'Run the tests and fix any failures.',
  permissions: { filesystem: 'project', shell: true, git: true, network: false },
  timeout: 20 * 60 * 1000,
});
// run: { id, provider, status, startedAt, completedAt, exitCode, summary,
//        output, stderr, error, filesChanged, metadata }
```

`service.start(request)` returns `{ run, done, cancel }` for long runs; `service.subscribe(handler)` receives events; `service.cancel(runId)`, `service.get(id)`, `service.list()` and `service.discover()` do what they say.

**Task** (`normalizeTask`): `task`, `cwd` (required, absolute), `permissions` (`filesystem`, `shell`, `network`, `git`; default read-only, everything else off), `timeout` (ms), `environment` (extra variables), `metadata`. No vendor options exist on the task.

**Run statuses:** `queued`, `running`, `completed`, `failed`, `cancelled`, `needs_input` (the agent wanted something its permissions did not allow and could not ask).

**Runs are recorded** in the `coding_agent_runs` table: id, provider, task, directory, permissions, pid, exit code, summary, redacted output and stderr tails (64 KiB each), files changed, timestamps. After a restart, a run whose process no longer exists is marked failed. Provider credentials are never stored.

### Events

| Event | When | Durable |
|---|---|---|
| `coding.agent.started` / `completed` / `failed` / `cancelled` / `needs_input` | lifecycle | yes (event log) |
| `coding.agent.error` | a failure message | yes |
| `coding.agent.output` | each output line, `{ runId, provider, stream, data }` | live subscribers only |

Output lines are **not** written to the append-only event log, which other parts of U2OS read. They go to live subscribers and, redacted and capped, to the run record. The `coding` event domain is reserved, so packages cannot emit these events.

## As a capability (`coding.agent`)

`coding.agent` is registered in the capability registry, so packages can depend on it without naming a vendor. It needs the `shell.execute` permission, which you grant to the package.

Anything that acts without you typing the command (a package, a routine, a trigger) reaches a coding agent **only through the action gate**: policy, approval, the durable queue and the audit trail. The tool's policy key is `coding.agent`, and with no rule it **requires your confirmation**:

```yaml
# policies.yaml
coding:
  agent: confirm    # the default. Set `never` to forbid it entirely.
```

The tool is hidden from the planner, so a model cannot start a coding agent by proposing a plan. Only `npm run u2 -- coding-agent run` (you, at your terminal) and package invocations through the gate exist today. Declaring `requires: capability: coding.agent, preference: [...]` in a package manifest is not implemented: the package workflow language is frozen ([ADR 0009](adr/0009-extension-model-mcp-tools-vault-skills-routines.md)). The service already takes a `preference` list for when routines can name capabilities.

## Security model

- **Credentials.** The CLI owns authentication. U2OS never reads provider token files and never requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Those variables are deliberately **not** passed to the child, because they would switch a subscription-backed tool to metered API billing.
- **No shell.** The executable and arguments are an argument array with `shell: false`. The task text is sent on stdin, never on the command line, so it cannot inject commands or be read as an option.
- **Environment.** The child gets an allow-list (`PATH`, `HOME`, `USER`, locale, proxy and certificate variables, plus `CODEX_HOME` / `CLAUDE_CONFIG_DIR` so each tool finds its own settings), not U2OS's environment. `U2OS_*`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH` and `HOME` cannot be overridden by a task.
- **Working directory.** Required, absolute, symlinks resolved, must be an existing directory, never `/` or your whole home directory, and inside `roots` when you set them.
- **Bounded runs.** A timeout or cancel sends SIGTERM to the whole process group, then SIGKILL after a grace period. Captured output is size-capped.
- **Redaction.** Output, summaries, errors and the stored task pass a best-effort secret redactor (API keys, tokens, private keys, `password=` assignments, the task's own `environment` values). It is a safety net, not a guarantee.
- **Gated.** See above: confirm by default, hidden from the planner, audited.

### Enforcement gaps

The generic permissions are mapped to each tool's own controls where they exist. They are **not** equally enforceable, and U2OS does not pretend otherwise. `capabilities()` reports this per provider.

| Permission | Codex | Claude Code |
|---|---|---|
| `filesystem: read` / `none` | read-only sandbox (`none` is treated as read-only) | `plan` mode, no edits (`none` also denies the read tools) |
| `filesystem: project` | `workspace-write` sandbox | `acceptEdits`, confined to the working directory by Claude Code |
| `filesystem: unrestricted` | `danger-full-access` | treated as `project` |
| `network` | enforced for `workspace-write` (`network_access`); read-only has none | `WebFetch`/`WebSearch` denied. **Network from inside Bash is not enforced** |
| `shell: false` | **not enforced**, stated in the prompt only | enforced (Bash denied) |
| `git: false` | **not enforced**, stated in the prompt only | `Bash(git *)` denied; other routes not covered |

Where a permission is not enforced, U2OS adds a plain-language constraint to the prompt. That is a request to the model, not a security boundary. These tools can run code you did not review: give a run the least it needs, use `roots`, and use a clean git working tree so `filesChanged` and `git diff` show exactly what it did. This is not an isolation sandbox ([#291](https://github.com/chrisrobison/u2os/issues/291) tracks stronger isolation).

Other current limits: runs cannot be resumed (`resume` is false for both adapters), `needs_input` is reported but cannot be answered, there is no owner API route or UI for coding runs, and a run blocks for its full duration when started through the gate.

## Adding a provider

A provider is a class in `server/coding-agent/providers/` that extends `CliCodingAgentProvider` and supplies: `defaultExecutable`, `buildInvocation(task, { model })` (task → argv + stdin), `parseLine(stream, line, state)` (output line → display text) and `finalize({ state, result })` (summary, status, metadata). Add the class to `adapters` in `server/coding-agent/index.js`. The service, registry, CLI, events and gate do not change. A provider that is not a subprocess (a local model, ACP, MCP) extends `CodingAgentProvider` and implements `probe()`, `capabilities()` and `run()` itself. Tests use `tests/fixtures/fake-official-cli.js`, never the real tools.
