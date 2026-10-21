//! `u2`: command-line client for the local Majordomo daemon.
//!
//! Contains no business logic; it talks to the daemon's socket API (and, for
//! `doctor`, inspects the home read-only).

use majordomo::vault;
use majordomo::{client, config, doctor, Config, Error};
use serde_json::Value;
use std::process::ExitCode;

const USAGE: &str = "u2 - talk to the local Majordomo daemon

USAGE:
    u2 status [--json]   show daemon status
    u2 doctor            check the Majordomo footprint in the U2OS home
    u2 vault check [--vault DIR] [--json]
                         read-only check of the vault (no daemon needed)
    u2 --version | --help

ENVIRONMENT:
    U2OS_HOME            data home (default ~/.u2os)

EXIT CODES:
    0 ok   1 failure or daemon not running   64 usage error
";

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match refs.as_slice() {
        ["--version"] | ["-V"] => {
            println!("u2 {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["--help"] | ["-h"] | [] => {
            print!("{USAGE}");
            if refs.is_empty() {
                ExitCode::from(64)
            } else {
                ExitCode::SUCCESS
            }
        }
        ["status"] => finish(status(false).await),
        ["status", "--json"] => finish(status(true).await),
        ["doctor"] => finish(run_doctor().await),
        ["vault", "check", rest @ ..] => finish(vault_check(rest)),
        other => {
            eprintln!("u2: unknown command: {}\n\n{USAGE}", other.join(" "));
            ExitCode::from(64)
        }
    }
}

fn finish(result: Result<bool, Error>) -> ExitCode {
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("u2: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn status(json: bool) -> Result<bool, Error> {
    let config = Config::from_env()?;
    let reply = client::get(&config.socket_path, "/api/v1/status").await?;
    if reply.status != 200 {
        return Err(Error::Http(format!(
            "daemon answered HTTP {}",
            reply.status
        )));
    }
    if json {
        println!("{}", reply.body.trim_end());
        return Ok(true);
    }
    let v: Value = serde_json::from_str(&reply.body)
        .map_err(|e| Error::Http(format!("invalid status response: {e}")))?;
    println!(
        "majordomo {} (api {}, phase {})",
        text(&v["version"]),
        text(&v["api"]),
        text(&v["phase"])
    );
    println!("  pid:     {}", text(&v["pid"]));
    println!("  uptime:  {}s", text(&v["uptimeSeconds"]));
    println!("  home:    {}", text(&v["home"]));
    println!("  socket:  {}", text(&v["socket"]));
    println!("  responsibilities:");
    if let Some(map) = v["responsibilities"].as_object() {
        for (name, r) in map {
            println!(
                "    {:<13} owner={} majordomo={}",
                name,
                text(&r["owner"]),
                text(&r["majordomo"])
            );
        }
    }
    Ok(true)
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "-".to_string(),
        other => other.to_string(),
    }
}

async fn run_doctor() -> Result<bool, Error> {
    let config = Config::from_env()?;
    let report = doctor::run(&config).await;
    print!("{report}");
    Ok(!report.failed())
}

fn vault_check(args: &[&str]) -> Result<bool, Error> {
    let mut json = false;
    let mut dir: Option<std::path::PathBuf> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match *arg {
            "--json" => json = true,
            "--vault" => {
                let value = it
                    .next()
                    .ok_or_else(|| Error::Config("--vault needs a directory".into()))?;
                dir = Some(std::path::PathBuf::from(value));
            }
            other => {
                return Err(Error::Config(format!(
                    "unknown option for vault check: {other}"
                )))
            }
        }
    }
    let root = match dir {
        Some(d) => d,
        None => vault::locate(&config::home_from_env()?, std::env::var_os("U2OS_VAULT")),
    };
    let index = vault::scan(&root)?;
    if json {
        let out = serde_json::to_string_pretty(&index).map_err(|e| Error::Http(e.to_string()))?;
        println!("{out}");
        return Ok(index.invalid.is_empty());
    }
    println!("vault: {}", index.root);
    println!(
        "  files:   {}  valid: {}  invalid: {}",
        index.files,
        index.records.len(),
        index.invalid.len()
    );
    for type_name in ["Person", "Project", "Commitment"] {
        let n = index.of_type(type_name).count();
        if n > 0 {
            println!("  {type_name:<11} {n}");
        }
    }
    for note in &index.notes {
        println!("  note: {note}");
    }
    for bad in &index.invalid {
        println!("  INVALID {}: {}", bad.path, bad.error);
    }
    if index.invalid.is_empty() {
        println!("ok: every vault file was read and understood");
    }
    Ok(index.invalid.is_empty())
}
