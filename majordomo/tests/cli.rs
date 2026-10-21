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
