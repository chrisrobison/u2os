//! `majordomo`: run the daemon in the foreground until SIGINT/SIGTERM.

use majordomo::{logging, Config, Daemon, Error};
use std::process::ExitCode;

const USAGE: &str = "majordomo - U2OS deterministic daemon (foundation phase)

USAGE:
    majordomo            run in the foreground until SIGINT/SIGTERM
    majordomo --version
    majordomo --help

ENVIRONMENT:
    U2OS_HOME               data home (default ~/.u2os); uses <home>/majordomo/
    MAJORDOMO_LOG           log filter (default: info)
    MAJORDOMO_LOG_FORMAT    set to 'json' for JSON lines
";

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => {}
        Some("--version") | Some("-V") => {
            println!("majordomo {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("--help") | Some("-h") => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some(other) => {
            eprintln!("unknown argument: {other}\n\n{USAGE}");
            return ExitCode::from(64);
        }
    }

    logging::init();
    let result = async {
        let config = Config::from_env()?;
        Daemon::start(config).await?.run_until_signal().await
    }
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("majordomo: {e}");
            // 75 (EX_TEMPFAIL) lets supervisors tell "already running" from a crash.
            if matches!(e, Error::AlreadyRunning { .. }) {
                ExitCode::from(75)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}
