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
/// GitHub methods, implemented thinly over the `gh` CLI.
pub mod github;
/// Local AI-agent methods (list/config/commit_message/summarize_file/review).
pub mod agents;
/// Reviewer-comment methods (create/list/delete/send).
pub mod comments;
