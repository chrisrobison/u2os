//! `u2`: command-line client for the local Majordomo daemon.
//!
//! Contains no business logic; it talks to the daemon's socket API (and, for
//! `doctor`, inspects the home read-only).

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
    u2 memory list   [--type T] [--classification C] [--limit N] [--offset N]
    u2 memory search <words...> [same filters]
    u2 memory show   <id|path>
    u2 memory links  <id|path>
                         read-only queries over the vault (no daemon needed);
                         all accept --vault DIR and --json
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
        ["memory", sub, rest @ ..] => finish(memory(sub, rest)),
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
}

fn parse_opts(args: &[&str]) -> Result<Opts, Error> {
    let mut o = Opts {
        positional: Vec::new(),
        json: false,
        vault: None,
        query: Query::default(),
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
