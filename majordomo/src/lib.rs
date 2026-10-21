//! U2OS Majordomo: a small, deterministic local daemon.
//!
//! Foundation phase (ADR 0011, docs/majordomo.md): configuration, single
//! instance protection, lifecycle, logging and an owner-only local API. The
//! Node service remains authoritative for every responsibility.

pub mod api;
pub mod client;
pub mod config;
pub mod daemon;
pub mod doctor;
pub mod error;
pub mod fsutil;
pub mod lock;
pub mod logging;
pub mod server;

pub use config::Config;
pub use daemon::Daemon;
pub use error::{Error, Result};
