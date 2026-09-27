# Package security notes

Packages will eventually act autonomously on the owner's behalf, so U2OS treats every installed package as untrusted input and enforces its boundaries in code.

## What U2OS enforces

- **Validation.** Manifests, definitions and workflows are validated strictly (unknown keys, types, ids, versions, schema keywords, expressions, event types). YAML is parsed with the core schema, so custom tags cannot construct objects or code.
- **No install-time code.** Installing copies and validates files, then registers definitions. Nothing from the package is imported or executed.
- **Filesystem.** Package paths are relative, cannot contain `..`, hidden segments or backslashes, and are resolved without following symbolic links. Archives are listed first and rejected if any entry is absolute, climbs out, or is a link, device or FIFO; the extracted tree is scanned again. Git sources are cloned shallowly, without submodules or tags, with symlinks disabled.
- **No `eval`.** Expressions are parsed into an AST and interpreted over plain data with own-property reads only and a fixed set of pure functions. `pattern` is not supported in schemas, so packages cannot supply regular expressions.
- **Permissions at the capability boundary.** Every invocation checks that the package declared and the owner granted each required permission. The action queue checks again when an approved action finally executes, so revoking a grant or disabling a package stops pending work.
- **Principal rule.** Capability calls inside composed skills act with the root package's grants, so one package cannot borrow another's.
- **Policy is a ceiling, not a key.** Package policies are deterministic and can only tighten `policies.yaml`. Unknown operations default to asking the owner. A model may produce facts, never the decision.
- **One gate.** Package actions go through `Agent.evaluateAndMaybeExecute()`, the same path chat, routines and triggers use, with voice/goal/account gates intact.
- **Invisible to the planner.** Package capabilities are hidden tools: the chat model cannot see or propose them.
- **Identity.** Package actions are recorded with `actor.type = 'package'` and `requested_by = package:<id>`, never as the owner.
- **Events.** Packages can emit only declared event types outside reserved core domains (`email`, `calendar`, `agent`, `automation`, `package`, `vault`, …), always with `source: package:<id>`, so they cannot forge core events.
- **Runaway limits.** Hourly run caps, single concurrency by default, no self-triggering, bounded foreach, retries, nesting and expression work.
- **Audit.** Every package invocation, including denials, is an `agent_actions` row with `package_context` (package, automation, skill, run, root run, step, capability, provider, permission decision, policy decision).
- **Secrets.** Declared by name, stored encrypted in the credential vault, write-only through the API, and readable only by the declaring package's module code.

## What U2OS does not (yet) enforce

- **Module code is not sandboxed.** `module` implementations run inside the U2OS process with its full privileges. The `code.execute` grant makes that trust explicit, and U2OS checks it before every call, but a malicious module could ignore every other boundary. Only grant `code.execute` to code you have read or trust. Isolation (worker threads with Node's permission model, or a separate process) is future work.
- **Network host allow-lists** are not enforced; `network: { hosts: [...] }` is rejected rather than silently ignored.
- **Signing** of packages is not implemented; review the source.
- **Filesystem scopes** are validated and grantable, but no filesystem capability exists yet.
- Workflow step inputs and outputs are stored in the U2OS database (like action arguments and results) so runs can resume. They are not written to logs or events.

## Reviewing a package

1. `npm run u2 -- package review <source>` (or **Review** in the Packages view).
2. Read the permissions. Be deliberate about `email.send`, `browser.submit_forms`, `payments.spend`, `shell.execute`, `devices.control` and above all `code.execute`.
3. Read the automatic actions (package policies) and decide whether your `policies.yaml` should delegate them.
4. Install without `--grant-all`, grant what you accept, and enable automations when ready.
5. Watch `npm run u2 -- audit --package <id>` or Operations for what it actually does.
