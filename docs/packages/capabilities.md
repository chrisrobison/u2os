# Capability author guide

A capability is the lowest-level action U2OS can perform: `web.search`, `email.send`, `mock.job-search`. It is a **contract** (id, version, input and output schemas, effect, required permissions) with one or more **providers** that implement it. Callers depend on the contract, never on a provider.

## Core capabilities

Every built-in tool is a core capability under its existing id. Their providers are the connectors the owner configures in `connectors.yaml` (Gmail, IMAP/SMTP, Google Calendar, Brave Search, webhook notifications…), so a package that calls `email.send` works with whichever account the owner connected.

| Capability | Effect | Permission |
|---|---|---|
| `email.search`, `email.read` | read | `email.read` |
| `email.draft` | write | `email.draft` |
| `email.send` | write | `email.send` |
| `calendar.list` | read | `calendar.read` |
| `calendar.create`, `calendar.reschedule` | write | `calendar.write` |
| `contacts.search` | read | `contacts.read` |
| `tasks.list` | read | `tasks.read` |
| `tasks.create`, `tasks.complete` | write | `tasks.write` |
| `web.search` | read | `network` |
| `notifications.send` | write | `notifications.send` |
| `presentation.present`, `presentation.notify` | write | `devices.control` |

`npm run u2 -- capability list` shows the live list with providers. Tools without a mapping are not exposed to packages. `llm.*`, `browser.*` and `filesystem.*` capabilities are not provided yet.

## Defining a package capability

```yaml
# capabilities/lookup.yaml
id: my.lookup                 # must match the export id
version: 1.0.0                # defaults to the package version
description: Look something up.
effect: read                  # read | write (default write)
permissions: [network]        # permissions a caller's package must hold
inputSchema:
  type: object
  required: [name]
  properties:
    name: { type: string, minLength: 1, maxLength: 200 }
outputSchema:                 # optional; validated when present
  type: object
  required: [found]
implementation:
  type: fixture
  file: fixtures/directory.json
  output:
    found: "{{ input.name in data.entries }}"
    entry: "{{ coalesce(data.entries[input.name], null) }}"
```

### Effect

`read` means no external side effect. `write` means consequential: the owner's `policies.yaml` decides autonomy using the capability id as `domain.operation` (`my.lookup` → domain `my`, operation `lookup`). An operation with no rule **requires approval** (fail safe), so a new write capability always asks until the owner delegates it:

```yaml
# policies.yaml
my:
  lookup: autonomous
```

When unsure, declare `write`.

### Schemas

Input and output schemas use a closed JSON Schema subset: `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or a list), `properties`, `required`, `items`, `additionalProperties`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, plus the annotations `description`, `title`, `default`, `format`, `examples`. Anything else, including `pattern`, is rejected: untrusted regular expressions are a denial-of-service risk. Top-level `default`s are applied to input before validation.

### Implementations

| Type | Runs package code? | Use for |
|---|---|---|
| `fixture` | no | mock or static data from a package JSON file (≤ 1 MiB). `output` is a template over `input` and `data`, defaulting to `{{ data }}`. |
| `static` | no | a response computed only from the input (`output` template over `input`). Simulations and adapters. |
| `module` | **yes** | anything real. `module: src/provider.js`, `export: name` (default `default`). |

A module export is `async (input, context) => output`. `context` holds:

- `packageId`
- `settings`: the package's effective settings
- `getSecret(name)`: a declared secret's value, or `null`
- `invoke(capabilityId, input)`: call another capability as this package, permission-checked and audited; it throws unless the call completes (it cannot wait for approval)
- `idempotencyKey`: set when the action queue executes the call; pass it to external APIs that support idempotency

Module code needs the owner to grant `code.execute`, checked before every call. It runs in the U2OS process with U2OS's privileges; see [security](security.md).

### Alternative providers

A package may implement a capability contract declared by another package:

```yaml
id: acme.job-search           # this provider's own id
implements: mock.job-search   # the contract it satisfies
permissions: [network]
implementation: { type: module, module: src/acme.js }
```

The owner chooses between providers (`PUT /api/packages/capabilities/:id/provider`); otherwise the declaring package's provider is used. Packages cannot yet replace the providers of core capabilities; connector selection for those stays in `connectors.yaml`.

## How an invocation runs

1. Input defaults and schema validation.
2. Provider resolution.
3. Permission check: every required permission declared by the calling package **and** granted by the owner.
4. The package policy decision, if the workflow step names one.
5. `Agent.evaluateAndMaybeExecute()`: `policies.yaml`, an `agent_actions` audit row with `package_context`, then blocked, pending approval, or the durable action queue.
6. When the queue executes an approved action, it re-checks that the package is still installed, enabled and granted.
7. Output schema validation.

Package capabilities are hidden from the chat planner: the model never sees or proposes them.
