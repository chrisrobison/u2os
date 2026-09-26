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
```

Routine files are described in [routines](routines.md). The rest of this page covers identity and memory files.

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
| `name` or `title` | Display name. Falls back to the first `# Heading`, then the file name. |
| `classification` | `public`, `personal` (default), `private` or `sensitive`. Applies to the entity and all its facts. It decides which facts may reach a local or remote model ([policies](policies.md)). An unknown value makes the file invalid rather than silently less private. |
| `sensitive_keys` | List of keys classified `sensitive` regardless of the file classification. |
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
- Entity identity is derived from the file path, so renaming a file is treated as delete plus create.
- `me.md` is applied once an owner account exists.

U2OS checks the vault every 5 seconds (`U2OS_VAULT_POLL_MS`) and re-indexes when a file is added, removed or changed. The owner-only API:

- `GET /api/vault` returns the vault location and the last index report (counts, file paths and parse errors, never contents).
- `POST /api/vault/reindex` indexes immediately and returns the report.

## Safety

- Only regular `.md` files directly inside the known folders are read. Hidden files and symlinks are ignored, so a link cannot pull content from outside the vault.
- Files over 256 KiB, invalid YAML, and invalid classifications are reported in the index report and skipped. The rest of the vault still indexes, and the invalid file's previously indexed records stay as they were.
- The vault holds personal data in plain text. Keep it on an encrypted disk, and treat any git remote or sync service as a destination for everything in it.

## Backups

The default vault lives inside `U2OS_HOME`, so `npm run backup` includes it. Backups refuse symlinks anywhere in the home. If you place the vault elsewhere with `U2OS_VAULT` or `vaultDir`, back it up yourself; git works well.

## Not yet supported

- Editing a vault fact in the Memory UI is not written back to the file, and the next change to that file wins ([#361](https://github.com/chrisrobison/u2os/issues/361)). Edit the file instead.
- Exporting existing database memory into vault files ([#359](https://github.com/chrisrobison/u2os/issues/359)).
- A journal of observations and actions ([#360](https://github.com/chrisrobison/u2os/issues/360)) and vault policies ([#362](https://github.com/chrisrobison/u2os/issues/362)).
