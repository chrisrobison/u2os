# 0011 — Rust Majordomo: incremental migration of the deterministic core

## Status

Accepted. Tracking issue [#602](https://github.com/chrisrobison/u2os/issues/602). Supersedes the "Core language" deferral in PLAN.md (the owner has directed this work); it does not supersede any other ADR. Extends [0007](0007-owned-vault-is-the-digital-self.md), [0003](0003-policy-outside-the-model.md) and [0010](0010-lean-core-bundled-addons.md).

## Context

The Node.js service owns every deterministic responsibility: vault indexing, memory, policy, the durable action queue, the scheduler and routines, the event log, authentication and supervision. It works and has about 200 test files. The owner wants a lean, long-running Rust daemon, `majordomo`, to own those responsibilities, so the core can run in a small single binary, independent of any model, frontend or cloud service.

PLAN.md previously said a Rust core "is not planned" until the add-on contract was stable and a concrete problem existed. The owner has now directed the work. This ADR records how to do it without a rewrite-shaped risk. The full inventory, ownership model and threat model are in [docs/majordomo.md](../majordomo.md).

## Decision

1. **Migrate, do not port.** Rust takes over one deterministic responsibility at a time. Connectors (Gmail, calendar, IMAP/SMTP, Apple), voice, the browser extension, the model router and the Web Components UI stay in Node until a measured benefit justifies moving them. Node remains the connector and model sidecar.
2. **One owner per responsibility.** At any moment exactly one runtime owns each of: vault index writes, the action queue, schedules/routines, event-log writes, and sessions. A responsibility is owned by Node until an explicit, recorded handoff and owned by Rust afterwards. The non-authoritative runtime runs that responsibility disabled (read-only or off), never in parallel.
3. **Separate state until handoff.** Rust never opens Node's `u2os.sqlite` or `.runtime-lock.sqlite`. Rust state lives under `<U2OS_HOME>/majordomo/` (its own lock, socket and `majordomo.sqlite`). Moving a responsibility means a designed export/import step in that phase, with restart-recovery tests, not shared file access.
4. **The vault stays the source of truth, in the existing format.** The Rust vault engine reads today's files unchanged: optional `id:`, path-derived identity, the fixed folder layout, 256 KiB limit, regular non-hidden `.md` files, no symlinks, and the classification rules. New capabilities in the brief are additive:
   - `id` is an opaque string. Existing `id:` values (database record ids) are honoured as they are. UUIDv7 is used only for newly created canonical memories. No existing file receives a generated id without an explicit owner-approved migration command, and path-derived identity remains valid.
   - A `type:` field and relationships are optional. When absent the type comes from the folder, as today.
   - Unknown frontmatter keys are preserved.
5. **Policy parity first, extension second.** The Rust engine reproduces today's semantics (`always`/`autonomous`/`confirm`/`never` per `domain.operation`, sub-categories resolved from authoritative context only, invalid vault policy fails closed to confirm, reads ungated). Its `Allow`/`RequireApproval`/`Deny` decision is a typed projection of those levels (`always`/`autonomous` → Allow, `confirm` → RequireApproval, `never` → Deny, plus the existing `blocked` flag). Any change in outcomes needs its own ADR and test.
6. **Local transport is a Unix domain socket first.** Phase 1 exposes `/api/v1/*` over an owner-only socket (directory 0700, socket 0600, peer uid checked). TCP is not opened. If HTTP is added later it binds to loopback only and reuses the existing session and CSRF protections. The Node browser session model is not weakened or bypassed.
7. **Rust conventions.** One crate with a library and binaries until a concrete need splits it. Stable toolchain; `fmt`, `clippy -D warnings`, tests required. No `unwrap`/`expect` in daemon paths. No `unsafe` without a written justification. Dependencies are added when their phase needs them, not speculatively.
8. **Equivalence is tested, not asserted.** Each ownership move uses shared fixtures that run identical inputs through Node and Rust and compare observable results (policy decisions, index contents, queue state transitions). A subsystem is retired in Node only after parity, restart-recovery and UI checks pass.

## Contradictions found and resolutions

| Brief | Current U2OS | Resolution |
|---|---|---|
| Required UUIDv7 `id` on every memory | `id` optional; binds to a DB record id; identity may be the path | Opaque string ids; UUIDv7 for new files only; no silent id generation (decision 4) |
| Arbitrary memory `type:` and layout | Fixed folders define type; only `people/`, `projects/`, `commitments/`, `me.md` index into memory | Folder default, `type:` optional override; wider layout is a later additive change |
| `PolicyDecision` enum | Levels per `domain.operation` + sub-category context, `blocked` | Projection in decision 5 |
| Rust owns SQLite action queue | Node owns `u2os.sqlite`, exclusive runtime guard | Separate Rust store; handoff protocol (decisions 2–3) |
| Session/CSRF HTTP API | Passphrase owner session, cookie `u2os_session`, CSRF | Socket transport in Phase 1; HTTP only with equal protections (decision 6) |
| Git history layer | Backups are encrypted snapshots; vault may be a repo | Additive Phase 3; never auto-commit external edits or push |
| Rust daemon replaces Node routines | Routines claim `(routine, slot)` in `routine_runs` | Claim semantics preserved; ownership flipped only in Phase 7 |
| Frozen areas (AGENTS.md) | Package workflow language, expression interpreter, automation runtime frozen | Not ported; retired per ADR 0009/0010 |

## Consequences

- Two runtimes coexist for a long time. The cost is a handoff protocol and compatibility fixtures for each phase; the benefit is that no phase can break daily use.
- Until Phase 7, Node remains authoritative. Rust phases 1–6 are additive and can be tested against isolated homes without touching the owner's data.
- Real benefits (memory, startup, single binary) are claimed only from Phase 8 measurements.
- The Milestone B priority in PLAN.md stands. This work proceeds as an owner-directed track.

## Implementation status

Phase 0 (this ADR and [docs/majordomo.md](../majordomo.md)) and Phase 1 (daemon foundation) are tracked in [#603](https://github.com/chrisrobison/u2os/issues/603) and [#604](https://github.com/chrisrobison/u2os/issues/604).
