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
| `id` | Optional. Binds the file to an existing record, for example one imported from contacts or exported from the database, instead of creating a new one. It must name a known record that no other file describes, and it cannot name the owner. |
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
- Without `id`, a record's identity comes from the file path, so renaming the file is treated as delete plus create. With `id`, renaming keeps the record, and the new file replaces what the old one said.
- Deleting a file with `id` keeps the record and what other sources know about it; only the vault's facts are removed. Deleting a file without `id` soft-deletes its record.
- `me.md` is applied once an owner account exists.

U2OS checks the vault every 5 seconds (`U2OS_VAULT_POLL_MS`) and re-indexes when a file is added, removed or changed. The owner-only API:

- `GET /api/vault` returns the vault location and the last index report (counts, file paths and parse errors, never contents).
- `POST /api/vault/reindex` indexes immediately and returns the report.

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
- It never lowers privacy. The file's `classification` is the highest non-sensitive level among its facts, and sensitive facts are listed in `sensitive_keys`. A sensitive note is left out of the file and stays in the database.

The report lists written and skipped files and how many facts were left out.

## Safety

- Only regular `.md` files directly inside the known folders are read. Hidden files and symlinks are ignored, so a link cannot pull content from outside the vault.
- Files over 256 KiB, invalid YAML, and invalid classifications are reported in the index report and skipped. The rest of the vault still indexes, and the invalid file's previously indexed records stay as they were.
- The vault holds personal data in plain text. Keep it on an encrypted disk, and treat any git remote or sync service as a destination for everything in it.

## Backups

The default vault lives inside `U2OS_HOME`, so `npm run backup` includes it. Backups refuse symlinks anywhere in the home. If you place the vault elsewhere with `U2OS_VAULT` or `vaultDir`, back it up yourself; git works well.

## Not yet supported

- Editing a vault fact in the Memory UI is not written back to the file, and the next change to that file wins ([#361](https://github.com/chrisrobison/u2os/issues/361)). Edit the file instead.
- A journal of observations and actions ([#360](https://github.com/chrisrobison/u2os/issues/360)) and vault policies ([#362](https://github.com/chrisrobison/u2os/issues/362)).
