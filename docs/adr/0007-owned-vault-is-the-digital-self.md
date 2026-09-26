# 0007 — The owned vault is the digital self

## Status

Accepted. Partially supersedes [0004](0004-event-log-plus-relational-state.md) for owner-authored knowledge.

## Context

U2OS exists to consolidate a person's digital self into something they own, and to act on their behalf. By the time of this decision, that self lived only as rows in a 32-table SQLite database. Those rows were interleaved with sessions, queue leases, run counters and connector state. The owner could not open, read, edit, version, or carry their identity, people, projects, commitments, or standing instructions to another tool without going through U2OS's API.

The system also acted meaningfully only through the chat planner. Unattended triggers could only notify or create a task. That made U2OS behave like a carefully guarded chatbot, which is the opposite of the product's premise.

## Decision

1. **A plain-file vault is the source of truth for the owner's digital self.** It is a directory of Markdown files with optional YAML frontmatter (`me.md`, `people/`, `projects/`, `commitments/`, `routines/`), later extended with vault policy and an append-only journal. The owner can edit it with any editor, keep it in git, sync it, or read it without U2OS.
2. **SQLite is an index and a runtime, not the self.** Vault files are projected into the existing `entities`/`facts` tables with `vault:<path>` provenance so every existing consumer (context assembly, dashboards, memory views) works unchanged. Those projected rows can be rebuilt from the vault at any time. SQLite remains authoritative for operational state: sessions, the action queue, runs, audit, connector sync state, and imported connector caches.
3. **The agent is a tool that uses the vault.** Models remain replaceable infrastructure ([0002](0002-model-is-replaceable-infrastructure.md)).
4. **The system acts on the owner's behalf through standing routines.** Routines are vault files containing a trigger and a plain-language instruction. They run unattended through the same planner → policy → durable queue → audit path as chat ([0003](0003-policy-outside-the-model.md)). Routines never gain authority that the owner has not delegated in policy.

## Consequences

- Owner-authored knowledge survives U2OS itself: deleting the database loses runtime history, not who the owner is.
- The file is the authority for vault-sourced facts. Edits made elsewhere must be written back to the file ([#361](https://github.com/chrisrobison/u2os/issues/361)), or they are reverted on the next index.
- Entity identity for vault records is derived from the file path. Renaming a file is a delete plus a create until an explicit `id` field is supported.
- Backups become simpler to reason about: the vault is the irreplaceable part, and it is ordinary files.
- Infrastructure hardening is deferred unless real use of the vault and routines surfaces a need.

See [the vault](../vault.md) and the [milestone](https://github.com/chrisrobison/u2os/issues/355).
