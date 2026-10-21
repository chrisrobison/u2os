//! Process-level tests: run the real `majordomo` and `u2` binaries against a
//! temporary U2OS home.

use std::fs;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const MAJORDOMO: &str = env!("CARGO_BIN_EXE_majordomo");
const U2: &str = env!("CARGO_BIN_EXE_u2");

fn home() -> TempDir {
    tempfile::Builder::new()
        .prefix("mj")
        .tempdir()
        .expect("tempdir")
}

fn socket(home: &Path) -> std::path::PathBuf {
    home.join("majordomo/run/majordomo.sock")
}

fn u2(home: &Path, args: &[&str]) -> Output {
    Command::new(U2)
        .args(args)
        .env("U2OS_HOME", home)
        .output()
        .expect("run u2")
}

fn spawn_daemon(home: &Path) -> Child {
    let mut child = Command::new(MAJORDOMO)
        .env("U2OS_HOME", home)
        .env("MAJORDOMO_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn majordomo");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket(home).exists() && u2(home, &["status"]).status.success() {
            return child;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("daemon did not become ready");
}

fn wait_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("daemon did not exit in time");
}

fn signal(child: &Child, name: &str) {
    let status = Command::new("kill")
        .args([&format!("-{name}"), &child.id().to_string()])
        .status()
        .expect("kill");
    assert!(status.success());
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn start_status_doctor_then_sigterm_stops_cleanly() {
    let dir = home();
    let mut daemon = spawn_daemon(dir.path());

    let status = u2(dir.path(), &["status"]);
    assert!(status.status.success());
    let out = text(&status.stdout);
    assert!(out.contains("phase vault-read"), "{out}");
    assert!(out.contains("action_queue"), "{out}");

    let json = u2(dir.path(), &["status", "--json"]);
    let v: serde_json::Value = serde_json::from_slice(&json.stdout).expect("json");
    assert_eq!(v["pid"], daemon.id());

    let doctor = u2(dir.path(), &["doctor"]);
    assert!(doctor.status.success(), "{}", text(&doctor.stdout));
    assert!(text(&doctor.stdout).contains("healthy"));

    signal(&daemon, "TERM");
    let exit = wait_exit(&mut daemon);
    assert!(exit.success(), "{exit:?}");
    assert!(!socket(dir.path()).exists(), "socket removed on shutdown");
    assert!(dir.path().join("majordomo/majordomo.lock").exists());
}

#[test]
fn sigint_also_stops_cleanly() {
    let dir = home();
    let mut daemon = spawn_daemon(dir.path());
    signal(&daemon, "INT");
    assert!(wait_exit(&mut daemon).success());
}

#[test]
fn second_daemon_exits_75_and_first_keeps_running() {
    let dir = home();
    let mut first = spawn_daemon(dir.path());

    let second = Command::new(MAJORDOMO)
        .env("U2OS_HOME", dir.path())
        .output()
        .expect("run second");
    assert_eq!(second.status.code(), Some(75));
    assert!(
        text(&second.stderr).contains("already running"),
        "{}",
        text(&second.stderr)
    );
    assert!(u2(dir.path(), &["status"]).status.success());

    signal(&first, "TERM");
    assert!(wait_exit(&mut first).success());
}

#[test]
fn kill9_leaves_a_stale_socket_that_the_next_start_replaces() {
    let dir = home();
    let mut first = spawn_daemon(dir.path());
    signal(&first, "KILL");
    let _ = wait_exit(&mut first);
    assert!(
        socket(dir.path()).exists(),
        "SIGKILL leaves the socket behind"
    );

    let doctor = u2(dir.path(), &["doctor"]);
    assert!(
        text(&doctor.stdout).contains("stale socket"),
        "{}",
        text(&doctor.stdout)
    );

    let mut second = spawn_daemon(dir.path());
    signal(&second, "TERM");
    assert!(wait_exit(&mut second).success());
}

#[test]
fn status_without_daemon_fails_with_a_clear_message() {
    let dir = home();
    let out = u2(dir.path(), &["status"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).contains("not running"),
        "{}",
        text(&out.stderr)
    );
}

#[test]
fn doctor_without_daemon_passes_and_never_creates_files() {
    let dir = home();
    let out = u2(dir.path(), &["doctor"]);
    assert!(out.status.success(), "{}", text(&out.stdout));
    assert!(text(&out.stdout).contains("not running"));
    assert!(
        !dir.path().join("majordomo").exists(),
        "doctor is read-only"
    );
}

#[test]
fn doctor_fails_on_a_non_socket_at_the_socket_path() {
    let dir = home();
    fs::create_dir_all(dir.path().join("majordomo/run")).unwrap();
    fs::write(socket(dir.path()), b"x").unwrap();
    let out = u2(dir.path(), &["doctor"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stdout).contains("FAIL"));
}

#[test]
fn usage_and_config_errors() {
    let dir = home();
    assert_eq!(u2(dir.path(), &["bogus"]).status.code(), Some(64));
    assert_eq!(u2(dir.path(), &[]).status.code(), Some(64));
    assert!(u2(dir.path(), &["--version"]).status.success());

    let out = Command::new(MAJORDOMO)
        .env("U2OS_HOME", "relative/home")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).contains("absolute"));
}

fn fixture_vault() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault")
}

#[test]
fn vault_check_reports_valid_and_invalid_files() {
    let dir = home();
    let out = Command::new(U2)
        .args(["vault", "check", "--vault"])
        .arg(fixture_vault())
        .env("U2OS_HOME", dir.path())
        .output()
        .unwrap();
    let s = text(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{s}");
    assert!(s.contains("INVALID people/bad-yaml.md"), "{s}");
    assert!(s.contains("Commitment"), "{s}");

    let json = Command::new(U2)
        .args(["vault", "check", "--json", "--vault"])
        .arg(fixture_vault())
        .env("U2OS_HOME", dir.path())
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(v["invalid"].as_array().unwrap().len(), 3);
    assert!(
        !dir.path().join("majordomo").exists(),
        "vault check writes nothing"
    );
}

#[test]
fn vault_check_locates_the_vault_like_node_and_never_creates_it() {
    let dir = home();
    // Default location is missing: error, and it is not created.
    let out = u2(dir.path(), &["vault", "check"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).contains("not found"),
        "{}",
        text(&out.stderr)
    );
    assert!(!dir.path().join("vault").exists());

    let vault = dir.path().join("vault/people");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("a.md"), "---\nname: A\n---\n").unwrap();
    let out = u2(dir.path(), &["vault", "check"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("ok:"));

    // config.json vaultDir, then U2OS_VAULT, take precedence in that order.
    fs::create_dir_all(dir.path().join("config")).unwrap();
    fs::write(
        dir.path().join("config/config.json"),
        r#"{"vaultDir":"elsewhere"}"#,
    )
    .unwrap();
    assert_eq!(u2(dir.path(), &["vault", "check"]).status.code(), Some(1));
    let out = Command::new(U2)
        .args(["vault", "check"])
        .env("U2OS_HOME", dir.path())
        .env("U2OS_VAULT", dir.path().join("vault"))
        .output()
        .unwrap();
    assert!(out.status.success());
}

fn memory_vault() -> TempDir {
    let dir = tempfile::Builder::new().prefix("mjv").tempdir().unwrap();
    let r = dir.path();
    fs::create_dir_all(r.join("people")).unwrap();
    fs::write(r.join("people/alice.md"), "---\nid: ent_alice\nname: Alice Chen\nemail: a@example.com\nrelationships:\n  - {predicate: sister_of, target: ent_bob}\n---\nLikes [Bob](u2os:ent_bob) and peanuts.\n").unwrap();
    fs::write(
        r.join("people/bob.md"),
        "---\nid: ent_bob\nname: Bob Stone\n---\n",
    )
    .unwrap();
    dir
}

fn mem(home: &Path, vault: &Path, args: &[&str]) -> Output {
    Command::new(U2)
        .arg("memory")
        .args(args)
        .arg("--vault")
        .arg(vault)
        .env("U2OS_HOME", home)
        .output()
        .unwrap()
}

#[test]
fn memory_commands_list_search_show_links() {
    let home_dir = home();
    let v = memory_vault();

    let list = mem(home_dir.path(), v.path(), &["list"]);
    assert!(list.status.success());
    assert!(
        text(&list.stdout).contains("2 of 2 shown"),
        "{}",
        text(&list.stdout)
    );

    let search = mem(home_dir.path(), v.path(), &["search", "PEANUTS"]);
    let out = text(&search.stdout);
    assert!(
        out.contains("Alice Chen") && out.contains("peanuts"),
        "{out}"
    );
    assert!(!out.contains("Bob Stone"));

    let json = mem(home_dir.path(), v.path(), &["search", "bob", "--json"]);
    let parsed: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(parsed["total"], 2);

    let show = mem(home_dir.path(), v.path(), &["show", "ent_alice"]);
    let out = text(&show.stdout);
    assert!(
        out.contains("email: a@example.com") && out.contains("ent_alice"),
        "{out}"
    );
    assert!(
        mem(home_dir.path(), v.path(), &["show", "people/alice.md"])
            .status
            .success(),
        "path also resolves"
    );

    let links = mem(home_dir.path(), v.path(), &["links", "ent_bob"]);
    assert!(
        text(&links.stdout).contains("Alice Chen sister_of this"),
        "{}",
        text(&links.stdout)
    );
    let links = mem(home_dir.path(), v.path(), &["links", "ent_alice"]);
    assert!(
        text(&links.stdout).contains("sister_of -> Bob Stone"),
        "{}",
        text(&links.stdout)
    );
}

#[test]
fn memory_command_errors() {
    let home_dir = home();
    let v = memory_vault();
    let unknown = mem(home_dir.path(), v.path(), &["show", "ent_nobody"]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(text(&unknown.stderr).contains("no memory"));
    assert_eq!(
        mem(home_dir.path(), v.path(), &["search"]).status.code(),
        Some(1)
    );
    assert_eq!(
        mem(
            home_dir.path(),
            v.path(),
            &["list", "--classification", "x"]
        )
        .status
        .code(),
        Some(1)
    );
    assert_eq!(
        mem(home_dir.path(), v.path(), &["frobnicate"])
            .status
            .code(),
        Some(1)
    );
    let none = Command::new(U2)
        .args(["memory", "list"])
        .env("U2OS_HOME", home_dir.path())
        .output()
        .unwrap();
    assert_eq!(none.status.code(), Some(1));
    assert!(!home_dir.path().join("vault").exists());
}

fn git_cmd(dir: &Path, date: &str, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
}

fn git_vault() -> TempDir {
    let dir = tempfile::Builder::new().prefix("mjv").tempdir().unwrap();
    let r = dir.path();
    fs::create_dir_all(r.join("people")).unwrap();
    git_cmd(r, "2025-01-01T00:00:00Z", &["init", "-q", "-b", "main"]);
    fs::write(r.join("people/alice.md"), "---\nid: ent_alice\nname: Alice\n---\nfirst version of the notes\nsecond line\nthird line\n").unwrap();
    git_cmd(r, "2025-01-01T00:00:00Z", &["add", "-A"]);
    git_cmd(
        r,
        "2025-01-01T00:00:00Z",
        &["commit", "-q", "-m", "add alice"],
    );
    git_cmd(
        r,
        "2025-03-01T00:00:00Z",
        &["mv", "people/alice.md", "people/alice-chen.md"],
    );
    git_cmd(
        r,
        "2025-03-01T00:00:00Z",
        &["commit", "-q", "-m", "rename alice"],
    );
    fs::write(r.join("people/alice-chen.md"), "---\nid: ent_alice\nname: Alice\n---\nedited version of the notes\nsecond line\nthird line\n").unwrap();
    git_cmd(
        r,
        "2025-06-01T00:00:00Z",
        &["commit", "-q", "-am", "edit alice"],
    );
    dir
}

#[test]
fn git_status_history_diff_rewind_commands() {
    let home_dir = home();
    let v = git_vault();
    let run = |args: &[&str]| {
        Command::new(U2)
            .args(args)
            .arg("--vault")
            .arg(v.path())
            .env("U2OS_HOME", home_dir.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap()
    };

    let status = run(&["git", "status"]);
    assert!(status.status.success());
    let s = text(&status.stdout);
    assert!(
        s.contains("branch:     main") && s.contains("commits:    3"),
        "{s}"
    );

    let history = run(&["history", "ent_alice"]);
    let s = text(&history.stdout);
    assert!(
        s.contains("edit alice") && s.contains("rename alice") && s.contains("add alice"),
        "{s}"
    );
    assert!(
        s.contains("R people/alice.md -> people/alice-chen.md"),
        "{s}"
    );
    assert!(run(&["history", "people/alice-chen.md", "--json"])
        .status
        .success());

    let diff = run(&["diff", "ent_alice", "--since", "2025-04-01"]);
    let s = text(&diff.stdout);
    assert!(
        s.contains("-first version") || s.contains("-edited") || s.contains("+edited version"),
        "{s}"
    );
    assert_eq!(
        run(&["diff", "ent_alice"]).status.code(),
        Some(1),
        "--since is required"
    );
    assert_eq!(
        run(&["diff", "ent_alice", "--since", "--output=/tmp/x"])
            .status
            .code(),
        Some(1)
    );

    let before = fs::read(v.path().join("people/alice-chen.md")).unwrap();
    let to = home_dir.path().join("snap");
    let rewind = run(&["rewind", "2025-02-01", "--to", to.to_str().unwrap()]);
    assert!(rewind.status.success(), "{}", text(&rewind.stderr));
    assert!(to.join("people/alice.md").is_file() && !to.join("people/alice-chen.md").exists());
    assert_eq!(
        fs::read(v.path().join("people/alice-chen.md")).unwrap(),
        before
    );
    assert!(text(&rewind.stdout).contains("private data"));
    assert!(
        mem(home_dir.path(), &to, &["list"]).status.success(),
        "snapshot is a readable vault"
    );
}

#[test]
fn rewind_defaults_to_a_private_directory_in_the_majordomo_home() {
    let home_dir = home();
    let v = git_vault();
    let out = Command::new(U2)
        .args(["rewind", "2025-02-01", "--vault"])
        .arg(v.path())
        .env("U2OS_HOME", home_dir.path())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    let snaps: Vec<_> = fs::read_dir(home_dir.path().join("majordomo/snapshots"))
        .unwrap()
        .collect();
    assert_eq!(snaps.len(), 1);
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&home_dir.path().join("majordomo/snapshots")), 0o700);
    assert_eq!(mode(&snaps[0].as_ref().unwrap().path()), 0o700);
}

#[test]
fn git_commands_on_a_vault_without_git_and_inherited_git_dir() {
    let home_dir = home();
    let plain = memory_vault();
    let out = Command::new(U2)
        .args(["git", "status", "--vault"])
        .arg(plain.path())
        .env("U2OS_HOME", home_dir.path())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(
        text(&out.stdout).contains("not in a git repository"),
        "{}",
        text(&out.stdout)
    );
    let out = Command::new(U2)
        .args(["history", "ent_alice", "--vault"])
        .arg(plain.path())
        .env("U2OS_HOME", home_dir.path())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).contains("not a git repository"),
        "{}",
        text(&out.stderr)
    );

    // A GIT_DIR inherited from the caller must not redirect us to another repo.
    let other = git_vault();
    let out = Command::new(U2)
        .args(["git", "status", "--json", "--vault"])
        .arg(plain.path())
        .env("U2OS_HOME", home_dir.path())
        .env("GIT_DIR", other.path().join(".git"))
        .env("GIT_WORK_TREE", other.path())
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["present"], false, "scrubbed GIT_DIR: {v}");
}

#[test]
fn doctor_reports_git_state_of_the_vault() {
    let home_dir = home();
    let v = git_vault();
    let out = Command::new(U2)
        .arg("doctor")
        .env("U2OS_HOME", home_dir.path())
        .env("U2OS_VAULT", v.path())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    let s = text(&out.stdout);
    assert!(s.contains("vault repository on main"), "{s}");
}
