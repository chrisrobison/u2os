# The vault: your digital self as files you own

The vault is a folder of plain Markdown files that holds who you are and what you care about. It is the source of truth for the digital self ([ADR 0007](adr/0007-owned-vault-is-the-digital-self.md)). U2OS reads it, and you can edit it with any text editor, keep it in git, or sync it however you like. If you delete U2OS's database, the vault is still yours, and U2OS rebuilds its memory from it on the next start.

## Location

The first match wins:

1. `U2OS_VAULT` environment variable.
2. `vaultDir` in `U2OS_HOME/config/config.json`. Relative paths are resolved against `U2OS_HOME`.
3. `U2OS_HOME/vault` (default).

On first start U2OS creates the default layout and a `README.md`. It never overwrites existing files.

```text
vault/
  README.md
  me.md            # you
  people/          # one file per person
  projects/        # one file per project
  commitments/     # things you have promised
  routines/        # standing instructions (see routines.md)
  skills/          # how you want things done; routines name them (see routines.md)
  policies.yaml    # optional: what U2OS may do without asking
  mcp.yaml         # optional: tool servers U2OS may start (see mcp.md)
  journal/         # written by U2OS: what it did on your behalf
```

Routine files are described in [routines](routines.md), and `policies.yaml` (what U2OS may do without asking) in [policies](policies.md#where-the-policy-lives), and `mcp.yaml` (tools from MCP servers) in [MCP tools](mcp.md). The rest of this page covers identity and memory files.

## File format

Each file is Markdown with optional YAML frontmatter:

```markdown
---
name: Alice Chen
email: alice@example.com
relationship: sister
birthday: 1990-05-01
classification: personal
sensitive_keys: [phone]
phone: "+1 555 0100"
---
Allergic to peanuts. Prefers texts to calls.
```

| Frontmatter | Meaning |
|---|---|
| `id` | Optional. Binds the file to an existing record, for example one imported from contacts or exported from the database, instead of creating a new one. It must name a known record that no other file describes, and it cannot name the owner. |
| `name` or `title` | Display name. Falls back to the first `# Heading`, then the file name. |
| `classification` | `public`, `personal` (default), `private` or `sensitive`. Applies to the entity and all its facts. It decides which facts may reach a local or remote model ([policies](policies.md)). An unknown value makes the file invalid rather than silently less private. |
| `sensitive_keys` | List of keys (including `notes`) classified `sensitive` regardless of the file classification. |
| `classifications` | Optional per-key levels, for example `{ email: public, phone: private }`. An unknown level makes the file invalid. `sensitive_keys` wins if a key is in both. |
| any other key | Becomes a fact with that key and value. Lists and nested values are kept as JSON. |
| body | Stored as a `notes` fact. |

Dates are kept as the strings you wrote. Only plain YAML types are accepted.

The folders map to entity types as follows:

- `me.md` holds facts about the owner entity (`name` included).
- `people/` holds `Person` entities.
- `projects/` holds `Project` entities.
- `commitments/` holds `Commitment` entities, promised by the owner. `status: open` (default) or `done` controls whether the agent treats them as open. `due` is kept as an attribute too.

## How indexing works

- Vault facts are **explicit** memory with source `vault:<path>`, for example `vault:people/alice-chen.md`.
- Indexing is idempotent. An unchanged vault performs no writes.
- Changing a value supersedes the old fact and links the replacement to it.
- Removing a key soft-deletes that fact, and removing a file soft-deletes its entity and vault facts. History is kept.
- Facts from other sources (connectors, inference, the agent) are never modified. If another explicit source stated a *different* value for the same key, both are marked `disputed` for you to resolve.
- Without `id`, a record's identity comes from the file path, so renaming the file is treated as delete plus create. With `id`, renaming keeps the record, and the new file replaces what the old one said.
- Deleting a file with `id` keeps the record and what other sources know about it; only the vault's facts are removed. Deleting a file without `id` soft-deletes its record.
- `me.md` is applied once an owner account exists.

The **Vault** view in the app shows the same: the index report with a **Re-read vault** button, whether `policies.yaml` is in effect or invalid, the tool servers with **Restart tool servers**, and the journal.

U2OS checks the vault every 5 seconds (`U2OS_VAULT_POLL_MS`) and re-indexes when a file is added, removed or changed. The owner-only API:

- `GET /api/vault` returns the vault location, the last index report (counts, file paths and parse errors, never contents), the vault policy status and the [MCP server](mcp.md) status.
- `GET /api/vault/journal?month=YYYY-MM&limit=100` returns the journal months and one month's entries, newest first (the latest month by default).
- `POST /api/vault/reindex` indexes immediately and returns the report.

## Editing from the UI

Owner edits made in the Memory view or through the memory API are written back to the vault file, so the file and U2OS never disagree. Each edit is applied in three steps:

1. The file is changed first.
2. The database records the edit for audit.
3. The vault is re-indexed.

| You do | The file |
|---|---|
| Correct a fact | Its line is replaced. The body is replaced for `notes`, and a changed key is renamed. |
| Delete a fact | Its key is removed (the body is cleared for `notes`). |
| Reclassify a fact | It is added to or removed from `sensitive_keys` (see below). |
| Accept a memory suggestion on a vault record | The key is added (a `notes` suggestion is appended to the body). |
| Delete a vault-backed record | The file moves to `.trash/` in the vault (hidden, not indexed, recoverable). |

This applies to records with a vault file and to facts about you. Facts about you go to `me.md`, which is created if missing. Records that exist only in the database stay database-only until you export them.

Some rules keep the file safe:

- **Minimal edits.** Only the affected lines change, so comments, ordering and formatting elsewhere are kept. If a targeted edit cannot be proven to produce exactly the intended file, the frontmatter is re-serialized, which drops frontmatter comments.
- **Atomic writes, conflict-aware.** The file is replaced atomically. If it changed on disk while the edit was prepared (for example you saved in your editor), the edit is refused with `409` and your save wins.
- **Exact privacy.** A reclassification is written exactly as chosen. A level equal to the file's `classification` needs no entry, `sensitive` goes into `sensitive_keys`, and any other level goes into `classifications`. U2OS never changes a level you did not ask to change.
- **File-only fields.** `id`, `name`, `title`, `classification`, `sensitive_keys` and `classifications` are edited in the file itself (except `name` in `me.md`).
- **Invalid files are never rewritten.** A file that does not currently parse is left alone, and the edit is refused until you fix it.
- **Vault relationships are changed in the file.** A commitment's link to you is removed by setting `status: done` or deleting the file, not through the relationship API.

## The journal

U2OS appends a line to `journal/YYYY-MM.jsonl` (by event month, UTC) for each thing it did on your behalf or you decided:

- routine runs
- actions proposed, approved, rejected, completed or failed
- sends, notifications and tasks
- memory suggestions
- memory changes, and commitments it noticed

It's your own history, readable with any tool and kept with the rest of your digital self:

```json
{"ts":"2026-09-28T07:00:03.120Z","type":"routine.fired","source":"routine","actor":{"type":"routine","id":"routines/morning-brief.md"},"eventId":"evt_…","data":{"routine":"routines/morning-brief.md","routineRunId":"rtn_…","trigger":"daily","slot":"daily:2026-09-28"}}
{"ts":"2026-09-28T07:00:09.884Z","type":"agent.action.completed","source":"agent","subject":{"type":"agent_action","id":"act_…"},"correlationId":"corr_…","eventId":"evt_…","data":{"tool":"notifications.send"}}
```

Entries hold types, identifiers, timestamps and a few metadata fields (tool, routine, key names, error codes). **They never hold** message bodies, action arguments, memory values, or model or provider text. Look up the detail by ID in U2OS's Activity, Operations and **Why?** views. Raw connector observations such as every synced email are not journaled. The journal is append-only; U2OS never rewrites it. If it cannot be written, events still flow normally and a warning is logged once.

## Moving existing memory into the vault

Installations that stored people, projects, commitments and facts about you before the vault existed can export them into files:

```sh
npm run vault:export      # with U2OS stopped
```

Or, while it runs, call the owner-only `POST /api/vault/export`, which exports and then re-indexes.

The export works as follows:

- It writes `me.md` plus one file per person, project and commitment not already described by the vault. Each file carries `id:`, so re-indexing binds it to the same record and nothing is duplicated.
- It never overwrites an existing file. `me.md` is skipped if you already wrote one, and a name collision gets a `-2` suffix.
- It never deletes database records. Once indexed, a vault value supersedes the identical database fact, so the file becomes the authority.
- It includes only explicit and imported facts. Inferred guesses stay out of your files and in U2OS's memory for review.
- It preserves every fact's classification exactly. The file carries the record's level, facts that differ are listed in `sensitive_keys` or `classifications`, and notes are included at their own level.

The report lists written and skipped files and how many facts were left out.

## Safety

- Only regular `.md` files directly inside the known folders are read. Hidden files and symlinks are ignored, so a link cannot pull content from outside the vault.
- Files over 256 KiB, invalid YAML, and invalid classifications are reported in the index report and skipped. The rest of the vault still indexes, and the invalid file's previously indexed records stay as they were.
- The vault holds personal data in plain text. Keep it on an encrypted disk, and treat any git remote or sync service as a destination for everything in it.

## Backups

The default vault lives inside `U2OS_HOME`, so `npm run backup` includes it. Backups refuse symlinks anywhere in the home. If you place the vault elsewhere with `U2OS_VAULT` or `vaultDir`, back it up yourself; git works well.

