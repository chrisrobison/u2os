# Dependable personal agent progress

Tracking issue: [#172](https://github.com/chrisrobison/u2os/issues/172). This record distinguishes code, fixture evidence, and owner-account validation. Update it after each merged slice.

| Area | Implemented | Fixture tested | Live validated | Remaining |
|---|---|---|---|---|
| Connector instances | Schema, legacy migration, CRUD, OAuth state binding, provider routing, named setup UI (PRs #168–#171, #174), consequential email/calendar account binding (#177), explicit IMAP/SMTP pairing (#178), persisted per-account/per-domain sync health (#179) | Node and browser flows for separate accounts, migration, OAuth binding, approved Gmail account selection, SMTP sender routing, and isolated sync status | No | Owner-driven live Google/IMAP validation (#150) |
| Personal initialization | Durable owner-to-entity link, name-independent context, authenticated legacy relink (#182); demo seeding and mock providers still exist | Rename, restart, legacy-link, deletion guard tests | No | Clean personal path and isolated demo mode (#180), honest disconnect states |
| Agent runs | One-pass plan, policy gate, durable action queue | Node and browser approval/queue suites | No | Persisted multi-step observations, dependencies, continuation, limits, resume |
| Conversations and search | Structured memory and limited context retrieval | Context/privacy suites | No | Scoped durable turns/references; account-scoped email search |
| Goals | Scheduler and event triggers | Scheduler suites | No | Durable goal state, budgets, owner view, job research workflow |
| Operations | Device trust, backup/export, action diagnostics | Existing Node/browser suites | No | Device route gating, consistent encrypted backup/restore, outage recovery |
| Daily workflows | Demo morning and meeting slices | Deterministic suites | No | Fresh/upgrade acceptance suite, owner walkthrough, dogfooding scorecard |

Owner action required for [#150](https://github.com/chrisrobison/u2os/issues/150): connect a real Google account and perform an opt-in Calendar/Gmail smoke check. Automated tests use isolated fixtures and have not accessed personal accounts, sent real messages, or changed real events.

Deferred: native mobile/watch apps, broad connector catalog, hosted service, multi-device sync, and a coding runner. A coding runner needs its own scoped design with isolated workspace, filesystem and resource boundaries, Git, tests, and artifact handling.
