# Task: Implement a Pluggable Coding Agent Capability for U2OS

You are working in the U2OS repository.

U2OS is an operating environment for the “digital you.” It has a capability/skill/automation architecture designed around composable components. We want to add a first-class **coding agent capability** that can delegate software-engineering tasks to existing AI coding harnesses such as:

- OpenAI Codex CLI
- Anthropic Claude Code
- Google Gemini CLI
- OpenCode
- local/offline coding agents

The important architectural constraint is:

> U2OS must NOT own, extract, proxy, or emulate the OAuth credentials used by these services.

Instead, U2OS should execute the provider's official CLI as a subprocess and allow that CLI to manage authentication, subscription billing, OAuth state, model selection, and provider-specific behavior.

For example:

```text
U2OS
  |
  +-- CodingAgent capability
        |
        +-- CodexAdapter
        |     +-- codex CLI
        |           +-- ChatGPT subscription / OAuth
        |
        +-- ClaudeCodeAdapter
        |     +-- claude CLI
        |           +-- Claude Pro/Max subscription
        |
        +-- GeminiAdapter
        |     +-- gemini CLI
        |
        +-- LocalAgentAdapter
              +-- local inference
```

The rest of U2OS should not care which provider performs the work.

---

# 1. First inspect the existing architecture

Before writing code:

1. Inspect the entire U2OS repository.
2. Identify the existing patterns for:
   - capabilities
   - skills
   - plugins
   - automations
   - subprocess execution
   - permissions
   - configuration
   - logging
   - event handling
   - persistence
3. Follow the project's existing conventions instead of inventing a parallel framework.
4. Reuse existing abstractions where appropriate.
5. Avoid unnecessary dependencies.

Document the relevant existing architecture briefly before implementing anything.

Do not perform a broad rewrite of U2OS.

---

# 2. Introduce a generic Coding Agent capability

Create a provider-independent abstraction representing an autonomous coding agent.

Conceptually:

```ts
interface CodingAgent {
    id: string;
    name: string;

    available(): Promise<boolean>;

    capabilities(): Promise<CodingAgentCapabilities>;

    run(task: CodingAgentTask): Promise<CodingAgentRun>;

    resume?(runId: string, input?: string): Promise<CodingAgentRun>;

    cancel?(runId: string): Promise<void>;
}
```

Adapt this shape to the project's existing language and conventions.

The API should support something conceptually equivalent to:

```js
await codingAgent.run({
    cwd: "/projects/u2os",

    task: `
        Implement issue #231.

        Run the test suite after making changes.
        Do not modify unrelated files.
    `,

    permissions: {
        filesystem: "project",
        network: true,
        git: true,
        shell: true
    }
});
```

The caller should NOT need to know whether this becomes:

```bash
codex ...
```

or:

```bash
claude ...
```

or another provider invocation.

---

# 3. Define a normalized task model

Create a provider-independent task representation.

At minimum support:

```ts
CodingAgentTask {
    task: string;
    cwd: string;

    permissions?: {
        filesystem?: "none" | "read" | "project" | "unrestricted";
        shell?: boolean;
        network?: boolean;
        git?: boolean;
    };

    timeout?: number;

    environment?: Record<string, string>;

    metadata?: Record<string, unknown>;
}
```

Add other fields only where justified.

Do not expose provider-specific options directly in the generic task object.

If providers require special configuration, put those values inside provider configuration.

---

# 4. Define normalized execution results

Every coding provider should return a normalized run object.

Example:

```ts
CodingAgentRun {
    id: string;

    provider: string;

    status:
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "needs_input";

    startedAt: string;

    completedAt?: string;

    exitCode?: number;

    summary?: string;

    output?: string;

    error?: string;

    filesChanged?: string[];

    metadata?: Record<string, unknown>;
}
```

If U2OS already has a generic Job/Run/Task execution model, integrate with it instead of duplicating it.

---

# 5. Provider adapter architecture

Create a provider adapter system.

Initial adapters:

```text
coding-agent/
    provider.ts
    registry.ts
    runner.ts

    providers/
        codex.ts
        claude-code.ts
```

Use the repository's preferred directory structure rather than blindly creating this exact layout.

The provider registry should support something similar to:

```js
const agent = codingAgents.get("codex");
```

or:

```js
const agent = await capabilities.resolve("coding.agent", {
    provider: "codex"
});
```

Prefer integration with the existing U2OS capability registry.

---

# 6. Implement Codex CLI support

Implement a Codex CLI adapter.

The adapter must:

- detect whether `codex` exists
- report whether the provider is available
- invoke Codex through a child process
- use the working directory supplied by U2OS
- capture stdout
- capture stderr
- capture exit status
- stream events where possible
- support cancellation
- avoid shell interpolation vulnerabilities
- never access Codex OAuth tokens directly

The adapter must assume the user has authenticated Codex separately using its normal login mechanism.

U2OS should only care whether:

```bash
codex
```

is callable and operational.

Do not require `OPENAI_API_KEY`.

Subscription-backed operation is one of the main reasons this abstraction exists.

---

# 7. Implement Claude Code support

Implement the equivalent adapter for:

```bash
claude
```

The adapter must:

- detect whether Claude Code is installed
- use the user's existing Claude Code authentication
- not inspect OAuth credentials
- not require `ANTHROPIC_API_KEY`
- invoke tasks non-interactively when supported
- capture output and errors
- support cancellation
- normalize provider results into the same CodingAgentRun structure

Provider-specific command-line arguments must remain encapsulated inside the adapter.

---

# 8. Provider discovery

U2OS should automatically detect installed providers.

For example:

```text
$ which codex
/usr/local/bin/codex

$ which claude
/usr/local/bin/claude
```

Expose something equivalent to:

```js
await codingAgents.discover();
```

returning:

```json
[
    {
        "id": "codex",
        "name": "OpenAI Codex CLI",
        "available": true
    },
    {
        "id": "claude-code",
        "name": "Claude Code",
        "available": true
    },
    {
        "id": "gemini",
        "name": "Gemini CLI",
        "available": false
    }
]
```

Do not assume providers are globally installed. Respect PATH and configurable executable locations.

---

# 9. Configuration

Support configuration conceptually similar to:

```yaml
codingAgents:

  default: codex

  providers:

    codex:
      enabled: true
      executable: codex

    claude-code:
      enabled: true
      executable: claude
```

Adapt this to the existing U2OS config format.

Also support provider ordering:

```yaml
preference:
  - codex
  - claude-code
  - local
```

This will eventually allow automations to request a capability rather than a specific vendor.

---

# 10. Capability-based resolution

The important abstraction is:

```text
capability: coding.agent
```

not:

```text
provider: openai
```

An automation should be able to declare:

```yaml
requires:
  - capability: coding.agent
```

or:

```yaml
requires:
  - capability: coding.agent
    preference:
      - codex
      - claude-code
      - local
```

The capability resolver should select the first available compatible implementation.

Use existing U2OS capability mechanisms if they already exist.

Do not hardwire coding-agent logic into the automation subsystem.

---

# 11. Long-running job support

Coding agents may run for minutes or potentially much longer.

They must therefore integrate with the U2OS job/task execution model.

A run should have:

```text
created
running
completed
failed
cancelled
needs_input
```

U2OS should retain:

- run ID
- provider
- task
- working directory
- timestamps
- process ID if applicable
- exit code
- summarized output
- relevant logs

Do not store provider OAuth credentials.

---

# 12. Streaming events

Expose structured events while the coding agent executes.

Conceptually:

```text
coding.agent.started
coding.agent.output
coding.agent.error
coding.agent.completed
coding.agent.failed
coding.agent.cancelled
coding.agent.needs_input
```

Use the existing U2OS event bus if one exists.

Example event:

```json
{
    "type": "coding.agent.output",
    "runId": "run_abc123",
    "provider": "codex",
    "stream": "stdout",
    "data": "Running tests..."
}
```

---

# 13. Security requirements

Treat coding agents as powerful local executors.

Do not simply expose unrestricted process execution.

At minimum:

### Working directory

Every run must have an explicit working directory.

Validate it.

Resolve symlinks where appropriate.

### Environment

Do not blindly forward the entire U2OS environment.

Create a controlled environment for child processes.

However, preserve what authenticated official CLIs legitimately require to find their own authentication/configuration data.

Do not copy provider credentials into U2OS storage.

### Command execution

Never construct commands like:

```js
exec(`codex ${userInput}`)
```

Use argument arrays and safe child-process APIs.

### Secrets

Task logs may contain sensitive output.

Use existing U2OS secret-redaction mechanisms if they exist.

### Permission policy

The generic task permissions should eventually allow U2OS policy to determine:

```text
Can the coding agent:

- modify files?
- execute shell commands?
- access the network?
- use git?
- operate outside the project?
```

Build the abstraction now even where individual CLIs cannot perfectly enforce every permission.

Document enforcement gaps.

---

# 14. Add an execution service

Create a higher-level service so callers do not normally interact with adapters directly.

Conceptually:

```js
const run = await codingAgentService.run({
    capability: "coding.agent",

    provider: "auto",

    cwd: "/projects/u2os",

    task: "Run the tests and fix any failures."
});
```

`provider: "auto"` should resolve according to configured preference and availability.

Also support:

```js
provider: "codex"
```

for explicit selection.

---

# 15. CLI integration

Add a U2OS command for testing and using this capability.

For example:

```bash
u2os coding-agent providers
```

Output:

```text
PROVIDER       STATUS
codex          available
claude-code    available
gemini         unavailable
```

And:

```bash
u2os coding-agent run \
    --provider codex \
    --cwd ~/projects/u2os \
    "Inspect this repository and fix the failing tests."
```

Also allow:

```bash
u2os coding-agent run \
    --provider auto \
    --cwd ~/projects/u2os \
    "Review this repository for obvious bugs."
```

Follow existing U2OS CLI conventions.

---

# 16. Prepare for additional providers

Do NOT implement everything now, but design adapters so adding:

```text
GeminiCLIProvider
OpenCodeProvider
LocalLLMProvider
RemoteAgentProvider
```

does not require changes to core execution logic.

A provider should largely consist of:

```text
detect
translate normalized task -> provider invocation
execute
translate provider output -> normalized events/result
```

---

# 17. Local provider considerations

Leave a clean extension point for local coding agents.

Future providers might use:

```text
LM Studio
llama.cpp
Ollama
ACP
MCP-based coding systems
custom U2OS coding agent
```

Do not couple the CodingAgent abstraction to OAuth or cloud services.

The abstraction represents a coding agent, not an API provider.

---

# 18. Authentication philosophy

This is critical.

U2OS should distinguish between:

```text
Credential ownership
```

and:

```text
Capability invocation
```

For Codex:

```text
U2OS
  -> launches codex
       -> Codex owns authentication
```

For Claude:

```text
U2OS
  -> launches claude
       -> Claude owns authentication
```

Do NOT implement:

```text
U2OS
  -> reads ~/.provider/oauth-token
  -> impersonates official CLI
```

Do NOT reverse engineer OAuth.

Do NOT proxy subscription access.

Do NOT convert subscription credentials into API credentials.

The official provider CLI remains the security and authentication boundary.

---

# 19. Tests

Add tests for at least:

### Provider detection

- executable exists
- executable missing
- executable configured with custom path

### Registry

- provider registration
- provider lookup
- automatic provider selection
- unavailable providers skipped

### Execution

Use mock executables rather than invoking real AI services.

Test:

- successful execution
- nonzero exit code
- stdout capture
- stderr capture
- timeout
- cancellation
- working-directory handling

### Security

Test:

- arguments aren't shell interpolated
- invalid cwd rejected
- environment filtering
- command injection attempts are harmless

Do not make CI depend on Codex or Claude being installed.

---

# 20. Documentation

Create documentation explaining:

## Coding Agents

Describe:

- what a coding agent capability is
- why U2OS treats CLI coding harnesses as capabilities
- supported providers
- installation requirements
- authentication model
- configuration
- CLI commands
- API usage
- security model

Example:

```text
Install Codex CLI
Authenticate with your ChatGPT account
Verify:

    codex

Then U2OS detects it automatically:

    u2os coding-agent providers
```

Likewise for Claude Code.

---

# 21. Architectural principle

The rest of U2OS should be able to say:

```js
const agent = await capabilities.resolve("coding.agent");

await agent.run({
    cwd: project.path,
    task: "Implement the next task in the project backlog."
});
```

It should NOT contain logic like:

```js
if (provider === "openai") {
   ...
} else if (provider === "anthropic") {
   ...
}
```

Provider-specific behavior belongs in adapters.

This is the same principle that should eventually allow U2OS automations to compose interchangeable capabilities like Lego pieces.

---

# 22. Scope for this implementation

Implement this in phases.

## Phase 1: Architecture

- inspect repository
- define CodingAgent abstraction
- integrate with capability registry
- normalized task/run types
- provider registry
- unit tests

Commit.

## Phase 2: Process execution

- safe subprocess runner
- cancellation
- timeout
- stdout/stderr streaming
- environment policy
- tests

Commit.

## Phase 3: Codex adapter

- detection
- invocation
- output normalization
- configuration
- tests using mocks

Commit.

## Phase 4: Claude Code adapter

- detection
- invocation
- output normalization
- configuration
- tests using mocks

Commit.

## Phase 5: CLI

- provider discovery command
- run command
- auto provider resolution
- usable output

Commit.

## Phase 6: Documentation and cleanup

- architecture docs
- usage docs
- examples
- test suite
- lint/typecheck
- remove dead code

Commit.

Do not combine all phases into one giant change.

---

# 23. Before each phase

Before modifying files:

1. inspect the relevant existing code
2. state the implementation approach
3. identify files likely to change
4. avoid unnecessary refactors

After each phase:

1. run relevant tests
2. run the project's lint/typecheck/build checks
3. inspect the diff
4. fix regressions
5. commit the completed phase

Use clear commit messages.

---

# 24. Definition of done

I should be able to install and authenticate Codex or Claude Code normally, then run:

```bash
u2os coding-agent providers
```

and see:

```text
codex          available
claude-code    available
```

Then:

```bash
u2os coding-agent run \
    --provider auto \
    --cwd ~/projects/example \
    "Inspect the project and explain the architecture."
```

U2OS should select an available provider, run it through its official CLI, stream progress, preserve the run record, and return a normalized result.

No OpenAI or Anthropic API key should be required when the corresponding authenticated subscription-backed CLI works normally.

Most importantly, the implementation should establish a clean generic:

```text
coding.agent
```

capability that can later be used by U2OS skills and automations without knowing which AI vendor is underneath it.
