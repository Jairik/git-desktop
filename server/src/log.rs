//! Minimal logging to stderr.
//!
//! The daemon is a local helper process, so a structured line per event on
//! stderr is all we need. The API is deliberately tiny: `info("msg").field(
//! "key", value)` logs when the temporary [`Logger`] is dropped.

use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether informational logging is enabled (set by `GITDAEMON_VERBOSE`).
static VERBOSE: AtomicBool = AtomicBool::new(false);

/// Initializes the logger from the environment.
pub fn init() {
    let verbose = std::env::var("GITDAEMON_VERBOSE")
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    VERBOSE.store(verbose, Ordering::Relaxed);
}

/// Whether verbose logging is enabled.
pub fn is_verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// A log record in the making.
///
/// The record is written to stderr when this value is dropped.
pub struct Logger {
    level: &'static str,
    message: String,
    fields: Vec<(String, String)>,
    enabled: bool,
}

impl Logger {
    /// Attaches a `key=value` pair to the record.
    pub fn field(mut self, key: &str, value: impl Display) -> Self {
        self.fields.push((key.to_string(), value.to_string()));
        self
    }
}

impl Drop for Logger {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }

        let mut line = format!("[gitdaemon] {} {}", self.level, self.message);

        for (key, value) in &self.fields {
            line.push_str(&format!(" {key}=\"{value}\""));
        }

        eprintln!("{line}");
    }
}

/// Creates an info level record.
pub fn info(message: impl Into<String>) -> Logger {
    Logger {
        level: "info",
        message: message.into(),
        fields: Vec::new(),
        enabled: true,
    }
}

/// Creates a warning level record.
pub fn warn(message: impl Into<String>) -> Logger {
    Logger {
        level: "warn",
        message: message.into(),
        fields: Vec::new(),
        enabled: true,
    }
}

/// Creates an error level record.
pub fn error(message: impl Into<String>) -> Logger {
    Logger {
        level: "error",
        message: message.into(),
        fields: Vec::new(),
        enabled: true,
    }
}

/// Creates a verbose-only record, dropped unless `GITDAEMON_VERBOSE` is set.
pub fn debug(message: impl Into<String>) -> Logger {
    Logger {
        level: "debug",
        message: message.into(),
        fields: Vec::new(),
        enabled: is_verbose(),
    }
}
