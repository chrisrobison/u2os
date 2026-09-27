# Writing U2OS packages

> **Direction update ([ADR 0009](../adr/0009-extension-model-mcp-tools-vault-skills-routines.md)):** packages, permissions, the single action gate, package policy and audit described here stand. The declarative workflow language for skills and automations is **frozen**: no new features, and it will be retired once the reference Job Hunter runs on MCP-provided tools, vault skills and routines ([#397](https://github.com/chrisrobison/u2os/issues/397)). Do not build new packages on it.

A package adds behaviour to U2OS without changing its core. It is a directory with a `u2os.yaml` manifest that exports any mix of:

- **capabilities**: primitive actions with typed input and output ([capability guide](capabilities.md))
- **skills**: short-lived reusable behaviour built from capabilities and other skills ([skill guide](skills.md))
- **automations**: durable, triggered workflows with persistent state ([automation guide](automations.md))

Read [security notes](security.md) before publishing anything. The design and its relationship to the rest of U2OS are in [the plugin architecture](../plugin-architecture.md). The [reference Job Hunter package](../../packages/job-hunter/README.md) is a complete, tested example.

## Layout

```text
my-package/
  u2os.yaml             required
  README.md
  capabilities/*.yaml   one file per exported capability
  skills/*.yaml         one file per exported skill
  automations/*.yaml    one file per exported automation
  workflows/*.yaml      workflows referenced by skills/automations
  fixtures/*.json       data for fixture capabilities
  src/*.js              code for module implementations (needs code.execute)
```

Only `u2os.yaml` is required. Paths in the manifest and definitions are package-relative: no absolute paths, no `..`, no hidden segments, no symbolic links. A package holds at most 1,000 files and 10 MiB, each file at most 1 MiB, and each YAML document at most 256 KiB. Hidden files such as `.git` are ignored and never installed.

## Manifest reference

```yaml
apiVersion: u2os/v1          # required, exactly this
kind: Package                # required, exactly this

metadata:
  id: com.example.my-package # required: lowercase reverse-DNS, the stable identity
  name: My Package           # required, 1-120 characters
  version: 0.1.0             # required, semantic version
  description: What it does. # optional; also author, license, homepage

requires:
  u2os: ">=0.1.0"            # optional range checked against U2OS's version
  capabilities:              # a list of ids, or a map of id -> version range
    web.search: ">=1.0"
  skills:
    company-research: "^1.0"

exports:
  capabilities: [{ id: my.lookup, file: capabilities/lookup.yaml }]
  skills:       [{ id: summarize-thing, file: skills/summarize.yaml }]
  automations:  [{ id: my-watcher, entrypoint: automations/watcher.yaml }]   # file or entrypoint

permissions:                 # what the package may ever do (see below)
  network: true
  email: { read: true, send: true }

policies:                    # when an action may happen without asking (see below)
  sendFollowup:
    description: Follow up after five quiet days
    all: ["input.daysSinceContact >= settings.followupDays"]
    approval: automatic      # automatic | required (default) | never

settings:                    # owner-configurable values; stored by U2OS, not in the package
  followupDays: { type: number, default: 5, minimum: 1 }

secrets: [gmail.oauth]       # names only; the owner stores values in U2OS

events:
  emits: [thing.found]       # every event type the package may emit
  subscribes: [mail.received] # informational

ui:
  dashboard: ui/dashboard.html  # recorded only; not served yet
```

Validation is strict: unknown keys, wrong types, invalid ids, unsafe paths, reserved or undeclared event types, and unsupported schema keywords are all rejected, and every problem is listed at once.

### Identifiers

| Kind | Form | Example |
|---|---|---|
| package | reverse-DNS | `package:com.example.my-package` |
| capability | dotted, 2-5 segments | `capability:web.search` |
| skill | lowercase, hyphenated | `skill:company-research` |
| automation | lowercase, hyphenated | `automation:job-hunter` |

Capability, skill and automation ids are global. Installing a package that reuses an id owned by another package fails.

### Dependencies

Everything a package's workflows use must be exported by the package itself or declared in `requires` and already installed at a compatible version. Ranges support `*`, exact versions, `>`, `>=`, `<`, `<=`, `^1.2`, `~1.2`, partial versions (`1`, `1.2`) and space-separated conjunctions (`>=1.0 <2.0`). Core capabilities are version `1.0.0`. There is no solver: one version of each package is installed.

A package must also **declare every permission its capabilities need, including those used through other packages' skills** (see the principal rule in the [skill guide](skills.md)).

### Permissions

| Manifest | Permission |
|---|---|
| `network: true` | `network` |
| `email: { read, draft, send }` | `email.read`, `email.draft`, `email.send` |
| `calendar: { read, write }` | `calendar.read`, `calendar.write` |
| `contacts: { read, write }` | `contacts.read`, `contacts.write` |
| `tasks: { read, write }` | `tasks.read`, `tasks.write` |
| `notifications: { send }` | `notifications.send` |
| `browser: { navigate, submitForms }` | `browser.navigate`, `browser.submit_forms` |
| `filesystem: { read: [scope], write: [scope] }` | `filesystem.read:<scope>`, `filesystem.write:<scope>`; scopes are logical names such as `profile.resume` or `jobs.*`, never paths |
| `microphone`, `camera`, `location: true` | same name |
| `shell: { execute }`, `devices: { control }`, `payments: { spend }` | `shell.execute`, `devices.control`, `payments.spend` |
| `code: { execute: true }` | `code.execute`, required for `module` implementations |

Installing grants nothing. The owner reviews the requested permissions and grants some or all of them. An action is permitted only when its capability's permissions are both declared **and** granted.

### Policies

A policy decides whether a specific action may happen without asking. It is evaluated by U2OS code over structured facts (the step's resolved `input`, `item`, `settings`, `state`, `inputs`):

| Conditions (`all`, `require`, `any`) | `approval` | Result |
|---|---|---|
| not met, or could not be evaluated | any | **deny**: the action is recorded as blocked and the item is skipped |
| met | `automatic` | the owner's `policies.yaml` decides |
| met | `required` | the owner must approve |
| met | `never` | **deny** |

The owner can override `approval` per policy. A package policy can never make an action more permissive than `policies.yaml`. Name policies after what they allow, and give each a `description`: it is what the owner reads at install time ("✓ Email me about very strong matches").

### Settings and secrets

Settings are typed values with defaults (`string`, `number`, `integer`, `boolean`, `array`, `object`, with the same schema keywords as capability schemas). The owner's values are stored in U2OS and validated against your schema; package files are never modified. Workflows read them as `settings.<name>`.

Secrets are declared by name. Values are stored encrypted by U2OS, are never returned by the API, and are available only to `module` code of the declaring package through `context.getSecret(name)`.

## Lifecycle

| Operation | CLI (server stopped) | API (server running, owner session) |
|---|---|---|
| Review | `npm run u2 -- package review <source>` | `POST /api/packages/review` |
| Install / upgrade | `npm run u2 -- package install <source> [--grant-all]` | `POST /api/packages/install` |
| Grant / revoke | `npm run u2 -- package grant <id> <permission…\|--all>` | `POST /api/packages/:id/grants` |
| Settings / policy overrides | `npm run u2 -- package config <id> key=value --policy name=never` | `PUT /api/packages/:id/settings` |
| Secret | `npm run u2 -- package secret <id> <name> <value\|--delete>` | `PUT /api/packages/:id/secrets/:name` |
| Enable / disable | `npm run u2 -- package enable <id>` | `POST /api/packages/:id/enable` |
| Uninstall | `npm run u2 -- package uninstall <id> [--force]` | `DELETE /api/packages/:id` |
| List / inspect | `package list`, `package show <id>`, `capability list`, `skill list` | `GET /api/packages`, `/api/packages/capabilities`, `/api/packages/skills` |
| Audit | `npm run u2 -- audit [--package id] [--automation id]` | `GET /api/packages/audit` |

Sources are a local directory, a `.tar`, `.tar.gz`, `.tgz` or `.zip` archive (a single top-level directory is fine), or a git repository as `git+https://host/repo.git#ref`, `git+file:///path/repo` or `https://host/repo.git`.

Installing reads and validates the manifest and every definition, checks compatibility and dependencies, copies the files into `U2OS_HOME/packages/<id>/<version>/`, validates the copy, registers everything, and leaves automations **disabled**. It never runs package code. Upgrading replaces the files, drops grants the new version no longer declares, and adds new automation state keys without removing existing ones. Uninstalling refuses while another package depends on it, cancels the package's active runs, and keeps run history, audit records, settings and automation state, so a reinstall resumes where it left off (with no grants).

## Testing a package

Package tests live in the U2OS repository's Node test suite. The pattern used by `tests/job-hunter-package.test.js`: create a temporary `U2OS_HOME`, build an `Agent` with fixed test policies, call `createPackagePlatform()`, `manager.install()` the package directory, grant, enable, drive triggers with `runtime.tick(now)` or events, and assert on runs (`runtime.runDetail`), state, events and `listPackageAudit()`.
