# Migration Policy

## Ordering
- Core schema initialization runs first (`db.initSchema`).
- Module SQL migrations run second in deterministic order:
  - module directory name order
  - migration filename ascending order inside each module
- Each migration uses a unique key in `schema_migrations` (`<moduleName>:<file>`).

## Startup Guard
- With `MIGRATIONS_STRICT_STARTUP=true`, startup verifies every discovered module migration key exists in `schema_migrations` after apply attempts.
- If any expected migration key is missing or migration execution fails, startup aborts.
- Server warmup initializes all active tenant runtimes to catch migration issues early.

## Rollback Policy
- Migrations are forward-only by default.
- Rollback is handled by restoring DB backups and redeploying a known-good app version.
- Emergency rollback steps are documented in `docs/backup-restore-playbook.md`.

## CI Verification
- `npm run test:migrations` verifies migration idempotency on sqlite and postgres (postgres in CI).
