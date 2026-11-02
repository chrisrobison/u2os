//! U2OS Majordomo: a small, deterministic local daemon.
//!
//! Foundation phase (ADR 0011, docs/majordomo.md): configuration, single
//! instance protection, lifecycle, logging and an owner-only local API. The
//! Node service remains authoritative for every responsibility.

pub mod actions;
pub mod api;
pub mod client;
pub mod clock;
pub mod config;
pub mod daemon;
pub mod date;
pub mod doctor;
pub mod error;
pub mod events;
pub mod fsutil;
pub mod git;
pub mod inspect;
pub mod lock;
pub mod logging;
pub mod memory;
pub mod scheduler;
pub mod server;
pub mod store;
pub mod vault;

pub use config::Config;
pub use daemon::Daemon;
pub use error::{Error, Result};
