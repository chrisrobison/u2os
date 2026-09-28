# Onboarding: the first-run wizard

PLAN.md's Milestone B asks for onboarding that starts from the vault: choose
its location, write or export `me.md`, add a first routine, configure a
model. Before this wizard, the owner passphrase screen (`_renderAuth()` in
`public/components/u2-app.js`) was followed directly by the full dashboard
shell -- an owner had to already know about the Vault, Model and Connectors
views, edit `me.md` by hand, and know which routine files to create. This
page describes the guided first run that replaces that drop-off, and the
API it is built on.

## When it appears

`u2-app.js`'s `connectedCallback()` checks two things in order after the
browser loads:

1. `GET /api/auth/status` -- if unauthenticated, the existing owner
   create/unlock screen renders (`_renderAuth()`, unchanged by this wizard).
2. Once authenticated, `GET /api/onboarding` -- if `completed` is `false`,
   `<u2-onboarding>` renders in place of the dashboard shell
   (`_renderOnboarding()`). Otherwise the shell renders exactly as it always
   has.

An owner who already completed onboarding is never shown the wizard again
on login. Reopening it later is a deliberate, separate action: the nav's
"Setup wizard" entry routes to `#/onboarding`, which mounts
`<u2-onboarding>` inside the normal shell (nav and agent panel stay
visible) instead of taking over the whole page. Revisiting the wizard this
way never re-gates the owner -- only the wizard's own finish step calls
`POST /api/onboarding`, and that call is idempotent (a second completion
keeps the original timestamp).

## The seven steps

Each step is individually reachable via the step tabs, and skippable with
**Skip for now** -- nothing consequential happens except from an explicit
button press within that step, the same explicit-consent spirit as the
Model view's save flow.

1. **Where your vault lives.** Shows the current `vaultDir`
   (`GET /api/vault`) and an optional form to relocate it
   (`POST /api/vault/location`). Relocation only succeeds while the current
   vault is empty (see below); leaving the field blank and continuing keeps
   the default location.
2. **Who you are.** A plain-text editor over `me.md`'s raw content
   (`GET`/`PUT /api/vault/me`). Frontmatter keys become facts U2OS can use,
   exactly as in the rest of the vault (see [vault.md](vault.md)).
3. **Choose intelligence.** Embeds the existing, self-contained
   `<u2-model>` component unmodified -- the same component the Model nav
   entry uses. Saving here follows that component's own explicit-consent
   save flow and restart requirement.
4. **Connect your world.** Embeds `<u2-connectors>`, restricted (via a
   `filterDomains` property) to just Gmail, Calendar and Contacts -- the
   same connector setup used by the full Connectors view, without
   duplicating any of its logic.
5. **Starter routines.** Lists the catalog from #412
   (`GET /api/vault/starter-routines`) with checkboxes; **Install
   selected** calls `POST /api/vault/starter-routines`, which installs each
   chosen item via `installStarterContent()` and never overwrites a file
   the owner already has.
6. **Review what U2OS may do.** A read-only summary: the vault location,
   which routines are enabled, and whether the vault's own `policies.yaml`
   is in effect or the built-in default policy applies, with links to the
   Vault and Routines views for closer inspection.
7. **Finish.** A single button calls `POST /api/onboarding`, then the
   wizard dispatches a `u2-onboarding-complete` event; `u2-app.js` handles
   it by re-running the same "start over" idiom `_renderAuth()`'s submit
   handler uses (`this._built = false; this.connectedCallback();`), which
   now finds onboarding complete and renders the normal shell.

## API

All routes are owner-only, like the rest of the vault API.

- `GET /api/onboarding` -- `{ completed: boolean, completedAt: string|null }`.
- `POST /api/onboarding` -- marks onboarding complete (idempotent) and
  returns the same shape.
- `GET /api/vault/me` -- `{ content: string, exists: boolean }`. If `me.md`
  does not exist yet, `content` is a default template (`exists: false`);
  nothing is written to disk by a `GET`.
- `PUT /api/vault/me` -- body `{ content: string }`. Syntactically broken
  YAML frontmatter is refused with `400` and never written, the same
  "never write an unparseable file" stance the rest of the vault write-back
  path takes. Otherwise the file is saved and the vault is reindexed
  immediately, so the change takes effect without waiting for the poll
  interval; the response's `report` is the reindex report, and `error` (if
  not `null`) is that specific reindex error for `me.md` -- for example an
  unrecognized `classification` value -- so the wizard can show it instead
  of silently accepting a broken save.
- `POST /api/vault/location` -- body `{ vaultDir: string }`. Relocates the
  vault by writing `vaultDir` into `config.json`, but **only when the
  current vault is empty** (no `me.md`, no facts sourced from the vault).
  This never deletes or moves existing files; it only changes where U2OS
  looks, and it never risks an existing owner's data. Distinct error codes
  are returned for each failure case:

  | HTTP | `code` | Meaning |
  |---|---|---|
  | 400 | `INVALID_INPUT` | `vaultDir` missing/blank, or resolves to a filesystem root. |
  | 409 | `VAULT_NOT_EMPTY` | The current vault already has `me.md` or indexed vault facts. |
  | 400 | `TARGET_NOT_DIRECTORY` | The target path exists and is not a directory. |
  | 409 | `TARGET_NOT_EMPTY` | The target directory exists and already has files in it. |
  | 400 | `TARGET_NOT_WRITABLE` | The target directory exists, is empty, but is not writable. |
  | 400 | `TARGET_CREATE_FAILED` | The target directory does not exist and could not be created. |

  On success the new location gets the standard layout
  (`ensureVaultLayout()`) and is reindexed immediately.
  `U2OS_VAULT` always overrides `config.json`'s `vaultDir`, same as
  everywhere else in the vault location precedence (see
  [vault.md](vault.md#location)) -- relocating through this route has no
  effect while that environment variable is set.
- `GET /api/vault/starter-routines` -- `{ catalog: [...], installed:
  [id, ...] }`, using #412's `listStarterContent()` and checking which
  catalog items' files already exist in the live vault.
- `POST /api/vault/starter-routines` -- body `{ ids: [id, ...] }`. Installs
  each id via `installStarterContent()`; the response's `results` array
  reports, per id, which files were newly installed versus already
  present, the same never-overwrite semantics #412 established.

## Testing

- `tests/onboarding-api.test.js` covers all four route groups: onboarding
  status get/set, `me.md` read/write with reindex-on-write and rejection of
  unparseable frontmatter, vault relocation succeeding only on an empty
  vault with each distinct error case, and starter-routine list/install.
- `tests/e2e/onboarding.spec.js` drives a fresh install through the real
  setup form and all seven steps to the dashboard, confirms an installed
  starter routine appears in the Routines view, confirms a second login for
  the same (now onboarded) owner goes straight to the dashboard, and
  confirms the wizard can be reopened from the nav without re-gating.
