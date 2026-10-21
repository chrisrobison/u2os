//! `u2 doctor`: read-only checks of the Majordomo footprint inside a U2OS home.
//!
//! The doctor never takes the instance lock and never opens Node's SQLite
//! files; it only inspects metadata and asks a running daemon for `/health`.

use crate::client;
use crate::config::Config;
use crate::error::Error;
use crate::fsutil::{self, PathKind};
use std::fmt;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug)]
pub struct Check {
    pub name: &'static str,
    pub level: Level,
    pub detail: String,
}

#[derive(Debug, Default)]
pub struct Report {
    pub checks: Vec<Check>,
}

impl Report {
    fn push(&mut self, name: &'static str, level: Level, detail: impl Into<String>) {
        self.checks.push(Check {
            name,
            level,
            detail: detail.into(),
        });
    }

    pub fn failed(&self) -> bool {
        self.checks.iter().any(|c| c.level == Level::Fail)
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for c in &self.checks {
            let tag = match c.level {
                Level::Ok => "ok  ",
                Level::Warn => "warn",
                Level::Fail => "FAIL",
            };
            writeln!(f, "[{tag}] {:<14} {}", c.name, c.detail)?;
        }
        Ok(())
    }
}

pub async fn run(config: &Config) -> Report {
    let uid = fsutil::effective_uid();
    let mut r = Report::default();

    match fs::metadata(&config.home) {
        Ok(m) if m.is_dir() => r.push("home", Level::Ok, config.home.display().to_string()),
        Ok(_) => r.push(
            "home",
            Level::Fail,
            format!("{} is not a directory", config.home.display()),
        ),
        Err(_) => r.push(
            "home",
            Level::Warn,
            format!(
                "{} does not exist yet (created on first start)",
                config.home.display()
            ),
        ),
    }

    check_private_dir(&mut r, "data dir", &config.data_dir, uid);
    check_private_dir(&mut r, "run dir", &config.run_dir, uid);
    check_lock_file(&mut r, &config.lock_path, uid);
    check_socket(&mut r, config).await;

    let node_db = config.home.join("db").join("u2os.sqlite");
    let node_guard = config.home.join(".runtime-lock.sqlite");
    if node_db.exists() || node_guard.exists() {
        r.push(
            "node data",
            Level::Ok,
            "present; Majordomo never opens it and owns no responsibility yet",
        );
    } else {
        r.push("node data", Level::Ok, "none found in this home");
    }
    r
}

fn check_private_dir(r: &mut Report, name: &'static str, path: &Path, uid: u32) {
    match fs::symlink_metadata(path) {
        Err(_) => r.push(
            name,
            Level::Ok,
            format!("{} not created yet", path.display()),
        ),
        Ok(m) if m.file_type().is_symlink() => r.push(
            name,
            Level::Fail,
            format!("{} is a symlink", path.display()),
        ),
        Ok(m) if !m.is_dir() => r.push(
            name,
            Level::Fail,
            format!("{} is not a directory", path.display()),
        ),
        Ok(m) if m.uid() != uid => r.push(
            name,
            Level::Fail,
            format!(
                "{} is owned by uid {}, expected {uid}",
                path.display(),
                m.uid()
            ),
        ),
        Ok(m) if m.mode() & 0o077 != 0 => r.push(
            name,
            Level::Warn,
            format!(
                "{} has mode {:o}; expected 700 (the daemon tightens it on start)",
                path.display(),
                m.mode() & 0o7777
            ),
        ),
        Ok(_) => r.push(name, Level::Ok, format!("{} (mode 700)", path.display())),
    }
}

fn check_lock_file(r: &mut Report, path: &Path, uid: u32) {
    match fs::symlink_metadata(path) {
        Err(_) => r.push("lock file", Level::Ok, "not created yet"),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => r.push(
            "lock file",
            Level::Fail,
            format!("{} is not a regular file", path.display()),
        ),
        Ok(m) if m.uid() != uid => r.push(
            "lock file",
            Level::Fail,
            format!("owned by uid {}, expected {uid}", m.uid()),
        ),
        Ok(m) if m.mode() & 0o077 != 0 => r.push(
            "lock file",
            Level::Warn,
            format!("mode {:o}; expected 600", m.mode() & 0o7777),
        ),
        Ok(_) => r.push(
            "lock file",
            Level::Ok,
            "present (mode 600); never delete it to bypass the lock",
        ),
    }
}

async fn check_socket(r: &mut Report, config: &Config) {
    let kind = match fsutil::classify(&config.socket_path) {
        Ok(k) => k,
        Err(e) => {
            r.push("socket", Level::Fail, e.to_string());
            return;
        }
    };
    match kind {
        PathKind::Missing => r.push("socket", Level::Ok, "absent: majordomo is not running"),
        PathKind::Symlink => r.push("socket", Level::Fail, "socket path is a symlink"),
        PathKind::Other => r.push(
            "socket",
            Level::Fail,
            "socket path exists and is not a socket",
        ),
        PathKind::Socket { .. } => match client::get(&config.socket_path, "/api/v1/health").await {
            Ok(reply) if reply.status == 200 => {
                r.push("socket", Level::Ok, "majordomo is running and healthy")
            }
            Ok(reply) => r.push(
                "socket",
                Level::Fail,
                format!("daemon answered HTTP {}", reply.status),
            ),
            Err(Error::NotRunning(_)) => r.push(
                "socket",
                Level::Warn,
                "stale socket; the next start replaces it",
            ),
            Err(e) => r.push("socket", Level::Fail, e.to_string()),
        },
    }
}
