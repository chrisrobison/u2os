# Tools from MCP servers

U2OS gets new tools from [Model Context Protocol](https://modelcontextprotocol.io) servers that you declare in your vault ([ADR 0009](adr/0009-extension-model-mcp-tools-vault-skills-routines.md)). A server runs as its own process. Its tools appear to the planner next to the built-in ones, and every call goes through the same gate as any other action: policy, the durable queue, approval and audit.

## Declaring servers: `mcp.yaml`

Put `mcp.yaml` at the top of your vault:

```yaml
servers:
  jobs:
    command: node
    args: ["${U2OS_ROOT}/mcp/jobs/server.js", "--vault", "${VAULT}"]
    env:
      JOBS_BROWSER_PATH: /usr/bin/chromium
    timeout_seconds: 180        # per call; default 120, at most 900
    tools:
      search_jobs: { read: true, classification: public }
      list_applications: { read: true, classification: personal }
      apply: {}
```

- **`command`, `args`**: how to start the server over stdio. `${U2OS_ROOT}` expands to the U2OS installation and `${VAULT}` to your vault.
- **`env`**: the only environment the server gets besides `PATH`, `HOME` and `LANG`. U2OS's own secrets, such as model API keys, are never passed on. Do not put secrets in the vault; it is plain text.
- **`enabled: false`** keeps a server declared but stopped.
- **`tools`**: only the tools listed here are exposed. A new tool a server adds later stays hidden until you list it.
  - `read: true` makes a tool read-only, so it runs without asking. Only your file decides this; a server's own "read-only" hint is not trusted. Every other tool is an action.
  - `classification` is the privacy level of the tool's results: `public`, `personal`, `private` (default) or `sensitive`. It decides which models may see the results ([data-processing policy](policies.md)). A result may label itself more restrictive, never less.

Each tool is named `<server>.<tool>`, such as `jobs.apply`. Server names use lowercase letters, digits and `_`. Names used by built-in tools (`email`, `calendar`, `web`, and so on) are refused, so a server can never inherit their policy.

Servers start with U2OS, from the vault directory. After editing `mcp.yaml`, restart U2OS, use **Restart tool servers** in the Vault view, or call `POST /api/vault/mcp/restart`. The app's **Vault** view, and `GET /api/vault`, report each server's state, its registered tools, tools you listed that the server does not offer, and errors. An invalid `mcp.yaml` starts no servers.

## What a tool may do without asking

Actions are governed by your [`policies.yaml`](policies.md#where-the-policy-lives) like built-in tools, with the server name as the domain:

```yaml
jobs:
  apply: autonomous      # or confirm (the default) or never
```

An action with no policy requires your confirmation. A server that crashes fails the call in progress and is restarted on the next call. A call that takes longer than `timeout_seconds` fails. Failed actions are not retried automatically, because U2OS cannot know whether the server's side effect happened.

## Trust

- A server runs with your user's permissions. Declaring one is like installing a program: only declare servers you trust, and remember that anyone who can edit your vault can declare one.
- Tool results are untrusted data for the planner, filtered by the data-processing policy before any model sees them. Results can never authorize an action or change policy.
- The arguments a tool receives come from the planner, which only sees context allowed by the data-processing policy for its model. A server that needs your details (such as the job-hunt server's applicant profile) should read them from a vault file you chose to share, not from the model.
- Servers cannot ask U2OS's model to do anything: sampling and other server-initiated requests are refused.
