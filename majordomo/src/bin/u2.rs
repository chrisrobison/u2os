//! `u2`: command-line client for the local Majordomo daemon.
//!
//! Contains no business logic; it talks to the daemon's socket API (and, for
//! `doctor`, inspects the home read-only).

use majordomo::git::{self, Git, RevSpec};
use majordomo::memory::{view, MemoryIndex, Query};
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
    u2 git status [--vault DIR] [--json]
                         health of the vault's Git repository
    u2 git checkin [--vault DIR] [--json]
                         commit the vault's dirty working tree now. Edits made outside
                         U2OS are included; on a conflict the current content is kept
                         and marker text is never committed. Never pushes.
    u2 history <id|path> [--limit N]      commits that touched a record, across renames
    u2 diff <id|path> --since DATE|COMMIT [--until DATE|COMMIT]
                         what changed (default: until the working tree)
    u2 rewind <DATE|COMMIT> [--to DIR]    extract a read-only snapshot of the vault
                         at that time; a date alone means the end of that day (UTC).
                         The vault itself is never touched. All accept --vault and --json
    u2 memory list   [--type T] [--classification C] [--limit N] [--offset N]
    u2 memory search <words...> [same filters]
    u2 memory show   <id|path>
    u2 memory links  <id|path>
                         read-only queries over the vault (no daemon needed);
                         all accept --vault DIR and --json
    u2 --version | --help

ENVIRONMENT:
    U2OS_HOME            data home (default ~/.u2os)
    MAJORDOMO_CHECKIN    1 = the daemon checks in vault changes in the background
                         (default off); MAJORDOMO_CHECKIN_QUIET_SECS sets the quiet period

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
        ["memory", sub, rest @ ..] => finish(memory(sub, rest)),
        ["git", "status", rest @ ..] => finish(git_status(rest)),
        ["git", "checkin", rest @ ..] => finish(git_checkin(rest)),
        ["history", rest @ ..] => finish(history(rest)),
        ["diff", rest @ ..] => finish(diff(rest)),
        ["rewind", rest @ ..] => finish(rewind(rest)),
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

struct Opts {
    positional: Vec<String>,
    json: bool,
    vault: Option<std::path::PathBuf>,
    query: Query,
    since: Option<String>,
    until: Option<String>,
    to: Option<std::path::PathBuf>,
}

fn parse_opts(args: &[&str]) -> Result<Opts, Error> {
    let mut o = Opts {
        positional: Vec::new(),
        json: false,
        vault: None,
        query: Query::default(),
        since: None,
        until: None,
        to: None,
    };
    let mut it = args.iter();
    let bad = |m: String| Error::Config(m);
    while let Some(arg) = it.next() {
        let mut value = |name: &str| -> Result<String, Error> {
            it.next()
                .map(|v| (*v).to_string())
                .ok_or_else(|| bad(format!("{name} needs a value")))
        };
        match *arg {
            "--json" => o.json = true,
            "--vault" => o.vault = Some(value("--vault")?.into()),
            "--since" => o.since = Some(value("--since")?),
            "--until" => o.until = Some(value("--until")?),
            "--to" => o.to = Some(value("--to")?.into()),
            "--type" => o.query.type_name = Some(value("--type")?),
            "--classification" => {
                let v = value("--classification")?;
                o.query.classification = Some(
                    majordomo::api::parse_classification(&v)
                        .ok_or_else(|| bad(format!("unknown classification: {v}")))?,
                );
            }
            "--limit" => {
                o.query.limit = value("--limit")?
                    .parse()
                    .map_err(|_| bad("--limit must be a number".into()))?
            }
            "--offset" => {
                o.query.offset = value("--offset")?
                    .parse()
                    .map_err(|_| bad("--offset must be a number".into()))?
            }
            flag if flag.starts_with("--") => return Err(bad(format!("unknown option: {flag}"))),
            word => o.positional.push(word.to_string()),
        }
    }
    Ok(o)
}

fn memory(sub: &str, args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = match opts.vault.take() {
        Some(d) => d,
        None => vault::locate(&config::home_from_env()?, std::env::var_os("U2OS_VAULT")),
    };
    let index = MemoryIndex::build(vault::scan(&root)?);
    match sub {
        "list" => {
            if !opts.positional.is_empty() {
                return Err(Error::Config(
                    "memory list takes no arguments; use memory search".into(),
                ));
            }
            print_page(&index, &opts, &opts.query.clone())
        }
        "search" => {
            if opts.positional.is_empty() {
                return Err(Error::Config(
                    "memory search needs at least one word".into(),
                ));
            }
            let q = opts
                .query
                .clone()
                .with_text(&opts.positional.join(" "))
                .map_err(Error::Config)?;
            print_page(&index, &opts, &q)
        }
        "show" | "links" => {
            let [key] = opts.positional.as_slice() else {
                return Err(Error::Config(format!(
                    "memory {sub} needs exactly one id or path"
                )));
            };
            let Some(record) = index.get(key).or_else(|| index.vault.by_path(key)) else {
                return Err(Error::Config(format!("no memory with id or path: {key}")));
            };
            if sub == "show" {
                show(record, opts.json)
            } else {
                links(&index, record, opts.json)
            }
        }
        other => Err(Error::Config(format!("unknown memory command: {other}"))),
    }
}

fn print_json(value: &Value) -> Result<bool, Error> {
    let out = serde_json::to_string_pretty(value).map_err(|e| Error::Http(e.to_string()))?;
    println!("{out}");
    Ok(true)
}

fn print_page(index: &MemoryIndex, opts: &Opts, q: &Query) -> Result<bool, Error> {
    let page = index.search(q);
    if opts.json {
        return print_json(&view::page(&page));
    }
    for hit in &page.hits {
        let r = hit.record;
        println!(
            "{:<31} {:<10} {}  ({})",
            r.id,
            r.kind.type_name(),
            r.name,
            r.path
        );
        if let Some(s) = &hit.snippet {
            println!("    {s}");
        }
    }
    println!("{} of {} shown", page.hits.len(), page.total);
    Ok(true)
}

fn show(r: &vault::Record, json: bool) -> Result<bool, Error> {
    if json {
        return print_json(&view::full(r));
    }
    println!("{}  [{}]", r.name, r.kind.type_name());
    println!(
        "  id:             {}{}",
        r.id,
        if r.id_from_file {
            ""
        } else {
            "  (derived from path)"
        }
    );
    println!("  path:           {}", r.path);
    println!("  classification: {:?}", r.classification);
    for (key, fact) in &r.facts {
        let level = if fact.classification == r.classification {
            String::new()
        } else {
            format!("  [{:?}]", fact.classification)
        };
        println!("  {key}: {}{level}", text(&fact.value));
    }
    Ok(true)
}

fn links(index: &MemoryIndex, r: &vault::Record, json: bool) -> Result<bool, Error> {
    if json {
        return print_json(&view::links(index, r));
    }
    println!("{} ({})", r.name, r.id);
    println!("  links to:");
    for l in index.outgoing(&r.id) {
        match l.to.as_deref().and_then(|id| index.get(id)) {
            Some(t) => println!("    {} -> {} ({})", l.predicate, t.name, t.id),
            None => println!("    {} -> {}  DANGLING", l.predicate, l.target),
        }
    }
    println!("  linked from:");
    for l in index.backlinks(&r.id) {
        let from = index
            .get(&l.from)
            .map_or(l.from.as_str(), |f| f.name.as_str());
        println!("    {from} {} this", l.predicate);
    }
    Ok(true)
}

fn vault_root(opts: &mut Opts) -> Result<std::path::PathBuf, Error> {
    Ok(match opts.vault.take() {
        Some(d) => d,
        None => vault::locate(&config::home_from_env()?, std::env::var_os("U2OS_VAULT")),
    })
}

fn git_status(args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = vault_root(&mut opts)?;
    if !root.is_dir() {
        return Err(Error::Config(format!(
            "vault directory not found: {}",
            root.display()
        )));
    }
    let h = git::Health::inspect(&Git::new(&root))?;
    if opts.json {
        return print_json(&serde_json::to_value(&h).unwrap_or(Value::Null));
    }
    println!("git {}", h.git_version);
    if !h.present {
        println!("  the vault is not in a git repository (history features are optional)");
    } else {
        println!(
            "  repository: {}{}",
            h.toplevel.as_deref().unwrap_or("?"),
            if h.is_vault_root {
                ""
            } else {
                "  (larger than the vault)"
            }
        );
        println!(
            "  branch:     {}",
            h.branch
                .as_deref()
                .unwrap_or(if h.detached { "(detached)" } else { "(none)" })
        );
        println!(
            "  commits:    {}",
            h.commits
                .map_or_else(|| "none".to_string(), |n| n.to_string())
        );
        println!(
            "  changes:    {} staged, {} modified, {} untracked, {} unmerged",
            h.staged, h.modified, h.untracked, h.unmerged
        );
        println!(
            "  remotes:    {}",
            if h.remotes.is_empty() {
                "none".to_string()
            } else {
                h.remotes.join(", ")
            }
        );
    }
    for w in &h.warnings {
        println!("  warning: {w}");
    }
    Ok(true)
}

fn git_checkin(args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = vault_root(&mut opts)?;
    if !root.is_dir() {
        return Err(Error::Config(format!(
            "vault directory not found: {}",
            root.display()
        )));
    }
    let r = git::checkin(&Git::new(&root))?;
    if opts.json {
        print_json(&serde_json::to_value(&r).unwrap_or(Value::Null))?;
    } else {
        match r.status {
            git::CheckinStatus::Committed => {
                println!(
                    "checked in {} file(s) as {}",
                    r.files,
                    r.commit.as_deref().map_or("?", |c| &c[..c.len().min(12)])
                );
                for p in &r.resolved_conflicts {
                    println!("  conflict resolved, current content kept: {p}");
                }
            }
            git::CheckinStatus::Clean => println!("nothing to check in"),
            git::CheckinStatus::Skipped | git::CheckinStatus::Busy => {
                println!("not checked in: {}", r.reason.as_deref().unwrap_or("?"));
            }
        }
    }
    Ok(matches!(
        r.status,
        git::CheckinStatus::Committed | git::CheckinStatus::Clean
    ))
}

/// A record id or path -> (path, bound id), using the vault index.
fn history_target(root: &std::path::Path, key: &str) -> Result<(String, Option<String>), Error> {
    let index = MemoryIndex::build(vault::scan(root)?);
    git::target_for(&index, key)
}

fn history(args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = vault_root(&mut opts)?;
    let [key] = opts.positional.as_slice() else {
        return Err(Error::Config("history needs exactly one id or path".into()));
    };
    let (path, id) = history_target(&root, key)?;
    let limit = if opts.query.limit == 0 {
        100
    } else {
        opts.query.limit
    };
    let h = git::record_history(&Git::new(&root), &path, id.as_deref(), limit)?;
    if opts.json {
        return print_json(&serde_json::to_value(&h).unwrap_or(Value::Null));
    }
    for e in &h.entries {
        println!(
            "{}  {}  {}  {}",
            &e.commit[..e.commit.len().min(10)],
            e.date,
            e.author,
            e.subject
        );
        for c in &e.changes {
            match &c.old_path {
                Some(old) => println!("    {} {old} -> {}", c.status, c.path),
                None => println!("    {} {}", c.status, c.path),
            }
        }
    }
    println!(
        "{} commit(s); paths: {}",
        h.entries.len(),
        h.paths.join(", ")
    );
    Ok(true)
}

fn diff(args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = vault_root(&mut opts)?;
    let [key] = opts.positional.as_slice() else {
        return Err(Error::Config("diff needs exactly one id or path".into()));
    };
    let since = RevSpec::parse(
        opts.since
            .as_deref()
            .ok_or_else(|| Error::Config("diff needs --since DATE|COMMIT".into()))?,
    )?;
    let until = opts.until.as_deref().map(RevSpec::parse).transpose()?;
    let (path, id) = history_target(&root, key)?;
    let g = Git::new(&root);
    let h = git::record_history(&g, &path, id.as_deref(), 0)?;
    let d = git::diff_paths(&g, &h.paths, &since, until.as_ref())?;
    if opts.json {
        return print_json(&serde_json::to_value(&d).unwrap_or(Value::Null));
    }
    if d.patch.is_empty() {
        println!("no changes");
    } else {
        print!("{}", d.patch);
        if d.truncated {
            println!("\n... output truncated");
        }
    }
    Ok(true)
}

fn rewind(args: &[&str]) -> Result<bool, Error> {
    let mut opts = parse_opts(args)?;
    let root = vault_root(&mut opts)?;
    let [when] = opts.positional.as_slice() else {
        return Err(Error::Config("rewind needs one DATE or COMMIT".into()));
    };
    let rev = RevSpec::parse(when)?;
    let g = Git::new(&root);
    let dest = match opts.to.take() {
        Some(d) => d,
        None => {
            let home = config::home_from_env()?;
            let data = home.join(config::DATA_DIR_NAME);
            let uid = majordomo::fsutil::effective_uid();
            majordomo::fsutil::ensure_private_dir(&data, uid)?;
            let dir = data.join("snapshots");
            majordomo::fsutil::ensure_private_dir(&dir, uid)?;
            let stamp: String = majordomo::date::format_utc(majordomo::date::now_epoch())
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            let label: String = when
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(24)
                .collect();
            dir.join(format!("{stamp}-at-{label}"))
        }
    };
    let info = git::snapshot(&g, &rev, &dest, &root)?;
    if opts.json {
        return print_json(&serde_json::to_value(&info).unwrap_or(Value::Null));
    }
    println!(
        "snapshot of commit {} written to {}",
        &info.commit[..info.commit.len().min(10)],
        info.dest.display()
    );
    println!(
        "  {} files, {} bytes; the vault and its repository were not touched",
        info.files, info.bytes
    );
    if info.skipped_links > 0 {
        println!("  {} symlink(s) were not extracted", info.skipped_links);
    }
    println!(
        "  inspect it with: u2 vault check --vault {0}   or   u2 memory list --vault {0}",
        info.dest.display()
    );
    println!("  it contains your private data; delete it when you are done");
    Ok(true)
}
