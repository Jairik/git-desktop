//! One handler per repository method.

/// Repository level methods.
pub mod repository;
/// Status and staging methods.
pub mod status;
/// Diff methods.
pub mod diff;
/// Commit and history methods.
pub mod log;
/// Branch methods.
pub mod branch;
/// Remote methods.
pub mod remote;
/// Tag methods.
pub mod tag;
/// Stash methods.
pub mod stash;
/// Config and identity methods.
pub mod config;
/// Network methods (fetch/pull/push/clone).
pub mod network;
