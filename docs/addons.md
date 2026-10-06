# Add-ons

An **add-on** is a folder that gives U2OS one more capability: tools from an MCP server, skills, routines and settings, described by a manifest. It is how U2OS grows without the core carrying every feature ([ADR 0010](adr/0010-lean-core-bundled-addons.md)). The core stays an orchestrator; everything that acts on the world is an add-on.

An add-on only **describes**. Whether it is enabled, which of its tools are read-only, how sensitive their results are, and what its settings are, are **your** decisions, kept in a vault file you own, `addons.yaml` (below). A claim in a manifest is a suggestion shown to you; it takes effect only when you confirm it.

> Status: this page is the contract. The manifest validator exists. Discovery and `addons.yaml` ([#464](https://github.com/chrisrobison/u2os/issues/464)), running add-on tools ([#465](https://github.com/chrisrobison/u2os/issues/465)), the Add-ons page ([#466](https://github.com/chrisrobison/u2os/issues/466)) and the first add-on, Apple apps ([#467](https://github.com/chrisrobison/u2os/issues/467)), follow. The older [packages](plugin-architecture.md) (workflow language) are unchanged and are being retired ([#402](https://github.com/chrisrobison/u2os/issues/402)).

## Where add-ons live

| Tier | Folder | Trust |
|---|---|---|
| **Bundled** | `addons/<id>/` in the U2OS installation | Shipped and reviewed with U2OS. Disabled until you enable it. |
| **Installed** | `U2OS_HOME/addons/<id>/` | Third party. Always runs out of process. |

Both tiers use the same manifest and the same gate. Installing never runs anything; enabling is what starts an add-on's server.

```text
addons/apple/
  addon.yaml        the manifest
  README.md         shown on the Add-ons page
  skills/*.md       optional, vault Markdown
  routines/*.md     optional, vault Markdown
```

## The manifest: `addon.yaml`

```yaml
apiVersion: u2os/v1
kind: Addon
metadata:
  id: apple                      # lowercase letters, digits, _ ; up to 32; not a built-in name
  name: Apple apps
  version: 0.1.0
  description: Calendar, Contacts, Mail, Messages, Notes, Reminders and Maps on this Mac.
requires:
  platform: [darwin]             # optional: darwin, linux, win32
  commands: [bunx]               # optional: programs that must be on PATH
  u2os: ">=0.1.0"                # optional
servers:
  apple:                         # the server name: the add-on id, or <id>_something
    command: bunx                # a command name, an absolute path, or ${ADDON_DIR}/relative/path
    args: ["apple-mcp@1.0.0"]    # pin versions
    timeout_seconds: 120
    tools:
      mail_unread:               # the tool U2OS exposes: apple.mail_unread
        tool: mail               # the server's own tool (default: same name)
        fixed: { operation: unread }   # arguments the model cannot change
        description: Read unread mail.
        read: true               # SUGGESTION: reads only
        classification: personal # SUGGESTION: privacy level of the results
      mail_send:
        tool: mail
        fixed: { operation: send }     # no suggestion: a consequential action
settings:
  limit: { type: number, default: 10, description: How many items to fetch. }
skills: [skills/inbox.md]
routines: [routines/morning.md]
ui:
  nav:
    - { id: apple, title: Apple, icon: apple-whole, group: Add-ons }
```

An add-on must contribute at least one of `servers`, `skills` or `routines`. Unknown keys are errors, and every problem in a manifest is listed at once.

### Tools and variants

Each entry under `tools` becomes one planner-visible tool named `<server>.<name>`. A server often offers one tool with an `operation` argument that mixes reading and writing (`mail` with `unread`, `search`, `send`). A **variant** exposes one operation as its own tool: `fixed` arguments are set by U2OS and the model cannot change them, so `apple.mail_unread` can be read-only while `apple.mail_send` needs confirmation, even though both call the server's `mail` tool.

### Suggestions versus decisions

`read` and `classification` in the manifest are what the author suggests. Until you confirm a tool, U2OS treats it as an **action that requires confirmation** with **private** results, whatever the manifest says. Confirming records your decision in `addons.yaml`. A tool a later version adds stays hidden until you review it.

### Trust and what an add-on cannot do

- A server runs as its own process with your account's permissions and a scrubbed environment (`PATH`, `HOME`, `LANG` and the `env` it declares). U2OS secrets, such as model keys, are never passed on.
- Every call goes through the same gate as built-in tools: policy (`policies.yaml`, domain = the server name), durable queue, approval and audit. Arguments pass the data-processing policy as an `external_tool` destination, and results are untrusted observations ([MCP tools](mcp.md#trust)).
- Names of built-in tools (`email`, `calendar`, `contacts`, `tasks`, `web`, ...) are reserved. A server name must be the add-on's id or start with `<id>_`, so an add-on cannot take another add-on's policy domain.
- Paths in the manifest are relative to the add-on folder and cannot escape it.

## Your decisions: `addons.yaml`

Next to `policies.yaml` and `mcp.yaml` in your vault ([#464](https://github.com/chrisrobison/u2os/issues/464)):

```yaml
addons:
  apple:
    enabled: true
    settings: { limit: 20 }
    tools:
      mail_unread: { read: true, classification: personal }   # confirmed by you
```

The file is the authority, and invalid content starts nothing. Servers you declare yourself in [`mcp.yaml`](mcp.md) keep working unchanged.

## What is not here yet

Skills and routines named in a manifest are validated now and installed into your vault in a later issue. In-process execution for bundled add-ons and migrating built-ins such as calendar ([#453](https://github.com/chrisrobison/u2os/issues/453)) come after the contract has been proven by a real add-on.
