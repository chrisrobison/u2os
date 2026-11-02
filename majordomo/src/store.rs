//! The Rust-owned operational store: `<U2OS_HOME>/majordomo/majordomo.sqlite`.
//!
//! **Node remains authoritative** (ADR 0011). This store is separate from
//! Node's `db/u2os.sqlite` and `.runtime-lock.sqlite`, neither of which is ever
//! opened. [`guard_store_path`] enforces that: the only path this module will
//! open is a file named `majordomo.sqlite` directly inside a directory named
//! `majordomo`, reached without `..` or symlinks.
//!
//! The schema is versioned through a `schema_version` table with additive,
//! forward-only migrations. A database written by a newer build is refused,
//! never downgraded.

use crate::fsutil;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::fs;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

pub const STORE_FILE_NAME: &str = "majordomo.sqlite";
pub const STORE_DIR_NAME: &str = crate::config::DATA_DIR_NAME;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("refusing store path {path}: {reason}")]
    Path { path: PathBuf, reason: String },
    #[error("store schema version {found} is newer than this build supports ({supported})")]
    SchemaTooNew { found: i64, supported: i64 },
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(String),
    #[error("invalid stored data: {0}")]
    Corrupt(String),
}

/// Statements applied in order; index + 1 is the schema version. Only ever
/// append: shipped entries are never edited.
const MIGRATIONS: &[&str] = &[
    "
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  data TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT
);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_correlation ON events(correlation_id);
CREATE INDEX idx_events_subject ON events(subject_type, subject_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL,
  consequential INTEGER NOT NULL CHECK (consequential IN (0, 1)),
  correlation_id TEXT,
  actor TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval','queued','leased','executing',
    'retry_wait','completed','failed','dead_letter','cancelled','outcome_uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  last_error TEXT,
  error_class TEXT,
  approved_by TEXT,
  approved_at_ms INTEGER,
  last_event_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_actions_runnable ON actions(status, next_attempt_at_ms);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  attempt_number INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executing','completed','failed','uncertain')),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  error TEXT,
  error_class TEXT,
  UNIQUE(action_id, attempt_number)
);
",
    "
-- Phase 4b scheduler: additive. One row per claimed (routine, slot); the
-- UNIQUE constraint is what makes a slot run at most once.
CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  routine TEXT NOT NULL,
  slot TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','enqueued','throttled')),
  action_id TEXT,
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(routine, slot)
);
CREATE INDEX idx_scheduler_runs_created ON scheduler_runs(created_at_ms);
CREATE TABLE scheduler_lease (
  name TEXT PRIMARY KEY CHECK (name = 'tick'),
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
",
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

fn bad_path(path: &Path, reason: &str) -> StoreError {
    StoreError::Path {
        path: path.to_path_buf(),
        reason: reason.to_string(),
    }
}

/// Refuse any path that is not `<...>/majordomo/majordomo.sqlite`. Pure
/// lexical checks plus a no-symlink check on whatever already exists, so a
/// planted link cannot redirect the store at Node's database.
pub fn guard_store_path(path: &Path) -> Result<(), StoreError> {
    if !path.is_absolute() {
        return Err(bad_path(path, "must be absolute"));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(bad_path(path, "must not contain . or .. components"));
    }
    if path.file_name().and_then(|n| n.to_str()) != Some(STORE_FILE_NAME) {
        return Err(bad_path(
            path,
            "the operational store file must be named majordomo.sqlite",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| bad_path(path, "has no parent directory"))?;
    if parent.file_name().and_then(|n| n.to_str()) != Some(STORE_DIR_NAME) {
        return Err(bad_path(
            path,
            "must live directly inside the majordomo/ directory",
        ));
    }
    for p in [parent, path] {
        match fs::symlink_metadata(p) {
            Ok(m) if m.file_type().is_symlink() => return Err(bad_path(p, "is a symlink")),
            Ok(m) if p == path && !m.is_file() => return Err(bad_path(p, "is not a regular file")),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(StoreError::Io(format!("stat {}: {e}", p.display()))),
        }
    }
    Ok(())
}

/// `<data_dir>/majordomo.sqlite` for a config's `data_dir`.
pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STORE_FILE_NAME)
}

#[derive(Debug)]
pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    /// Open (creating if needed) the store at a guarded path, with WAL,
    /// full synchronous durability and all migrations applied.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        guard_store_path(path)?;
        let parent = path
            .parent()
            .ok_or_else(|| bad_path(path, "has no parent directory"))?;
        fsutil::ensure_private_dir(parent, fsutil::effective_uid())
            .map_err(|e| StoreError::Io(e.to_string()))?;
        // Create the file 0600 ourselves so the database never exists with
        // looser permissions (SQLite copies the main file's mode to -wal/-shm).
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| StoreError::Io(format!("create {}: {e}", path.display())))?;
        guard_store_path(path)?;
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        migrate(&mut conn)?;
        Ok(Store {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    /// Read-only open for inspection. `Ok(None)` if the store does not exist
    /// (it is never created). The schema may be older than this build's.
    pub fn open_read_only(path: &Path) -> Result<Option<Store>, StoreError> {
        guard_store_path(path)?;
        if !path.exists() {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let version = schema_version(&conn)?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::SchemaTooNew {
                found: version,
                supported: SCHEMA_VERSION,
            });
        }
        if version < SCHEMA_VERSION {
            // Created by an older build or never migrated: nothing to show.
            return Ok(None);
        }
        Ok(Some(Store {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        self.with_conn(|c| schema_version(c))
    }

    /// Run `f` with exclusive use of the connection.
    pub fn with_conn<T, E: From<StoreError>>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut guard: MutexGuard<'_, Connection> =
            self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut guard)
    }
}

fn schema_version(conn: &Connection) -> Result<i64, StoreError> {
    let has_table: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Ok(0);
    }
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |r| r.get(0),
    )?)
}

fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
           version INTEGER PRIMARY KEY,
           applied_at_ms INTEGER NOT NULL
         );",
    )?;
    let current = schema_version(&tx)?;
    if current > SCHEMA_VERSION {
        return Err(StoreError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = index as i64 + 1;
        if version <= current {
            continue;
        }
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at_ms) VALUES (?1, ?2)",
            rusqlite::params![
                version,
                crate::clock::Clock::now_ms(&crate::clock::SystemClock)
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// A random identifier such as `act_3f9a...` (64 random bits, hex).
pub fn new_id(prefix: &str) -> Result<String, StoreError> {
    let mut bytes = [0u8; 8];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| StoreError::Io(format!("read random bytes: {e}")))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{prefix}_{hex}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::Builder::new().prefix("mjs").tempdir().unwrap();
        let d = t.path().join(STORE_DIR_NAME);
        (t, d)
    }

    #[test]
    fn guard_accepts_only_majordomo_sqlite_in_majordomo_dir() {
        let (_t, d) = data_dir();
        assert!(guard_store_path(&store_path(&d)).is_ok());
        for bad in [
            "/h/db/u2os.sqlite",
            "/h/.runtime-lock.sqlite",
            "/h/majordomo/u2os.sqlite",
            "/h/majordomo/.runtime-lock.sqlite",
            "/h/db/majordomo.sqlite",
            "/h/majordomo/sub/majordomo.sqlite",
            "/h/majordomo/../db/majordomo.sqlite",
            "/h/majordomo/../majordomo/majordomo.sqlite",
            "majordomo/majordomo.sqlite",
            "/majordomo.sqlite",
        ] {
            assert!(
                matches!(
                    guard_store_path(Path::new(bad)),
                    Err(StoreError::Path { .. })
                ),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn guard_refuses_symlinks() {
        let (t, d) = data_dir();
        let real = t.path().join("db");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("u2os.sqlite"), b"node").unwrap();
        fs::create_dir_all(&d).unwrap();
        std::os::unix::fs::symlink(real.join("u2os.sqlite"), d.join(STORE_FILE_NAME)).unwrap();
        assert!(guard_store_path(&store_path(&d)).is_err());
        assert!(Store::open(&store_path(&d)).is_err());
        // Node's file is untouched.
        assert_eq!(fs::read(real.join("u2os.sqlite")).unwrap(), b"node");

        let (t2, _) = data_dir();
        let link = t2.path().join("majordomo");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(Store::open(&link.join(STORE_FILE_NAME)).is_err());
        assert!(!real.join(STORE_FILE_NAME).exists());
    }

    #[test]
    fn open_creates_private_wal_store_at_current_version_and_is_reopenable() {
        let (_t, d) = data_dir();
        let path = store_path(&d);
        {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
            let mode: String = s
                .with_conn(|c| -> Result<_, StoreError> {
                    Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?)
                })
                .unwrap();
            assert_eq!(mode, "wal");
        }
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn newer_schema_is_refused() {
        let (_t, d) = data_dir();
        let path = store_path(&d);
        drop(Store::open(&path).unwrap());
        let c = Connection::open(&path).unwrap();
        c.execute(
            "INSERT INTO schema_version (version, applied_at_ms) VALUES (?1, 0)",
            [SCHEMA_VERSION + 1],
        )
        .unwrap();
        drop(c);
        assert!(matches!(
            Store::open(&path),
            Err(StoreError::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn read_only_open_never_creates() {
        let (_t, d) = data_dir();
        let path = store_path(&d);
        assert!(Store::open_read_only(&path).unwrap().is_none());
        assert!(!path.exists());
        assert!(!d.exists());
    }

    #[test]
    fn ids_are_prefixed_and_distinct() {
        let a = new_id("act").unwrap();
        let b = new_id("act").unwrap();
        assert!(a.starts_with("act_") && a.len() == 20);
        assert_ne!(a, b);
    }
}
