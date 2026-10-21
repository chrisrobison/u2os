//! Structured diagnostics to stderr. Logs carry identifiers and codes, never
//! vault content, credentials or request payloads.

use tracing_subscriber::EnvFilter;

/// `MAJORDOMO_LOG` sets the filter (default `info`); `MAJORDOMO_LOG_FORMAT=json`
/// switches to JSON lines. Safe to call more than once.
pub fn init() {
    let filter =
        EnvFilter::try_from_env("MAJORDOMO_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr);
    let result = if std::env::var("MAJORDOMO_LOG_FORMAT").is_ok_and(|v| v == "json") {
        builder.json().try_init()
    } else {
        builder.try_init()
    };
    // A second init in the same process (tests) is not an error.
    let _ = result;
}
