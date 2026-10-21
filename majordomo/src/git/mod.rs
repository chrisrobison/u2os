//! Git integration by shelling out to the `git` CLI.
//!
//! Every call is an argument array (never a shell), runs `git -C <vault>` with
//! the repository-redirecting environment variables removed, never prompts,
//! takes no optional locks (so `status` does not rewrite the index), and is
//! bounded in time and output size. Paths and revisions are validated before
//! they reach git, and always follow `--`.

mod diff;
mod history;
mod repo;
mod snapshot;

pub use diff::{diff_paths, resolve_rev, DiffResult, RevSpec};
pub use history::{record_history, target_for, Change, Entry, History};
pub use repo::Health;
pub use snapshot::{snapshot, SnapshotInfo};

use crate::error::{Error, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// Variables that would point git somewhere other than the vault.
const SCRUBBED_ENV: [&str; 9] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
];

#[derive(Debug, Clone)]
pub struct Git {
    root: PathBuf,
    env: Vec<(String, String)>,
    timeout: Duration,
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl Git {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Git {
            root: root.into(),
            env: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Extra environment for every call (tests use this to isolate git config).
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new("git");
        cmd.arg("--no-pager")
            .arg("-C")
            .arg(&self.root)
            .args([
                "-c",
                "core.quotepath=off",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "protocol.ext.allow=never",
            ])
            .args(args)
            .stdin(Stdio::null())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C");
        for var in SCRUBBED_ENV {
            cmd.env_remove(var);
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd
    }

    /// `git --version`, or an error if git is not installed.
    pub fn version(&self) -> Result<String> {
        let out = Command::new("git")
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| Error::Git(format!("git is not available: {e}")))?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .trim()
            .trim_start_matches("git version ")
            .to_string())
    }

    /// Run git; a non-zero exit is returned, not raised.
    pub fn run(&self, args: &[&str]) -> Result<Output> {
        let mut child = self
            .command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Git(format!("cannot run git: {e}")))?;
        let stdout = child.stdout.take().map(read_capped);
        let stderr = child.stderr.take().map(read_capped);

        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(Error::Git(format!(
                        "`git {}` timed out",
                        args.first().copied().unwrap_or("")
                    )));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(e) => return Err(Error::Git(format!("waiting for git: {e}"))),
            }
        };
        let join = |h: Option<std::thread::JoinHandle<Option<Vec<u8>>>>| -> Result<Vec<u8>> {
            h.and_then(|h| h.join().ok())
                .flatten()
                .ok_or_else(|| Error::Git("git produced more output than allowed".into()))
        };
        Ok(Output {
            stdout: join(stdout)?,
            stderr: String::from_utf8_lossy(&join(stderr)?).trim().to_string(),
            code: status.code().unwrap_or(-1),
        })
    }

    /// Run git and require success.
    pub fn run_ok(&self, args: &[&str]) -> Result<Vec<u8>> {
        let out = self.run(args)?;
        if out.code != 0 {
            if out.stderr.contains("not a git repository") {
                return Err(Error::Invalid("the vault is not a git repository".into()));
            }
            let first = args.first().copied().unwrap_or("");
            let detail: String = out
                .stderr
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect();
            return Err(Error::Git(format!(
                "`git {first}` failed ({}): {detail}",
                out.code
            )));
        }
        Ok(out.stdout)
    }

    pub fn run_text(&self, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.run_ok(args)?).into_owned())
    }

    /// Start git with stdout piped, for streaming (`git archive`).
    pub(crate) fn spawn_stdout(&self, args: &[&str]) -> Result<Child> {
        self.command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Git(format!("cannot run git: {e}")))
    }
}

/// Read a pipe on its own thread, keeping at most `MAX_OUTPUT_BYTES`. Returns
/// `None` if there was more (the excess is drained so git never blocks).
fn read_capped<R: Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<Option<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut pipe)
            .take(MAX_OUTPUT_BYTES as u64 + 1)
            .read_to_end(&mut buf);
        if buf.len() > MAX_OUTPUT_BYTES {
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            return None;
        }
        Some(buf)
    })
}

/// A vault-relative path that is safe to hand to git after `--`.
pub fn validate_path(path: &str) -> Result<()> {
    let bad = |why: &str| Err(Error::Invalid(format!("invalid vault path: {why}")));
    if path.is_empty() || path.len() > 500 {
        return bad("empty or too long");
    }
    if path.starts_with('/') || path.contains('\0') || path.contains('\\') {
        return bad("must be relative with / separators");
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return bad("no empty, . or .. components");
    }
    Ok(())
}
