//! Commit and history handlers: `commit.create`, `log.list`, `log.oneLine`,
//! `log.commit`, `log.changedFiles`, `commit.undo` and `commit.resetTo`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::git::commit::CreateCommitOptions;
use crate::models::CommitMessage;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `commit.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommitParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The commit message.
    pub message: CommitMessage,
    /// Files to stage before committing; the index is committed when omitted.
    #[serde(default)]
    pub files: Vec<String>,
    /// Amend the tip commit instead of creating a new one.
    #[serde(default)]
    pub amend: bool,
    /// Allow creating a commit without changes.
    #[serde(default)]
    pub allow_empty: bool,
}

/// Parameters for `log.list` and `log.oneLine`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogListParams {
    /// The absolute path of the repository.
    pub path: String,
    /// A revision range, e.g. `main..feature` or a single ref.
    #[serde(default)]
    pub revision_range: Option<String>,
    /// How many commits to return (defaults to 100).
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// How many commits to skip.
    #[serde(default)]
    pub skip: usize,
}

/// Parameters for `log.oneLine`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOneLineParams {
    /// The absolute path of the repository.
    pub path: String,
    /// A revision range.
    #[serde(default)]
    pub revision_range: Option<String>,
    /// How many commits to return (defaults to 100).
    #[serde(default = "default_limit")]
    pub limit: usize,
}

/// Parameters for `log.commit`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCommitParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The ref (branch, tag or SHA) to read.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// Parameters for `log.changedFiles`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFilesParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA of the commit.
    pub sha: String,
}

/// Parameters for `commit.undo`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA of the commit to revert.
    pub sha: String,
}

/// Parameters for `commit.resetTo`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA to move HEAD to.
    pub sha: String,
    /// `soft`, `mixed` or `hard`.
    pub mode: String,
}

/// The default history limit.
fn default_limit() -> usize {
    100
}

/// `commit.create` — create (or amend) a commit.
pub async fn commit_create(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CreateCommitParams = params_of(params)?;

    let sha = git::commit::create_commit(
        &state.runner,
        &params.path,
        &CreateCommitOptions {
            summary: params.message.summary,
            description: params.message.description,
            files: params.files,
            amend: params.amend,
            allow_empty: params.allow_empty,
        },
    )
    .await?;

    Ok(json!({ "sha": sha }))
}

/// `log.list` — the commit history.
pub async fn log_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: LogListParams = params_of(params)?;

    let commits = git::commit::list_log(
        &state.runner,
        &params.path,
        params.revision_range.as_deref(),
        Some(params.limit),
        Some(params.skip),
    )
    .await?;

    Ok(json!(commits))
}

/// `log.oneLine` — a compact history of shas and summaries.
pub async fn log_one_line(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: LogOneLineParams = params_of(params)?;

    let commits = git::commit::list_one_line(
        &state.runner,
        &params.path,
        params.revision_range.as_deref(),
        Some(params.limit),
    )
    .await?;

    Ok(json!(commits))
}

/// `log.commit` — a single commit, or null when the ref doesn't exist.
pub async fn log_commit(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: LogCommitParams = params_of(params)?;

    let commit = git::commit::get_commit(&state.runner, &params.path, &params.reference).await?;

    Ok(json!(commit))
}

/// `log.changedFiles` — the files and line counts of a commit.
pub async fn log_changed_files(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ChangedFilesParams = params_of(params)?;

    let changed = git::commit::changed_files(&state.runner, &params.path, &params.sha).await?;

    Ok(json!(changed))
}

/// `commit.undo` — revert a commit.
pub async fn commit_undo(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: UndoParams = params_of(params)?;

    git::commit::undo_commit(&state.runner, &params.path, &params.sha).await?;

    Ok(json!({}))
}

/// `commit.resetTo` — move HEAD to a commit.
pub async fn commit_reset_to(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ResetParams = params_of(params)?;

    git::commit::reset_to(&state.runner, &params.path, &params.sha, &params.mode).await?;

    Ok(json!({}))
}
