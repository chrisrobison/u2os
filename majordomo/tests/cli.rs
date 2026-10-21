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
    assert!(out.contains("phase foundation"), "{out}");
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
