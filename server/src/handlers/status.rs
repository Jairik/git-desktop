//! Status and staging handlers: `status.get`, `status.stage`,
//! `status.unstage`, `status.unstageAll` and `status.discard`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `status.get`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetStatusParams {
    /// The absolute path of the repository.
    pub path: String,
    /// Whether to include untracked files (defaults to true).
    #[serde(default = "default_true")]
    pub include_untracked: bool,
}

/// Parameters for `status.stage` and `status.unstage`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The files to operate on, relative to the repository root.
    pub files: Vec<String>,
}

/// Parameters for `status.discard`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The files to discard, relative to the repository root.
    pub files: Vec<String>,
    /// Whether untracked files should be deleted from disk.
    #[serde(default = "default_true")]
    pub include_untracked: bool,
    /// Accepted for compatibility; moving files to the trash is not
    /// implemented (the daemon is a local helper process and simply deletes).
    #[serde(default)]
    #[allow(dead_code)]
    pub move_to_trash: bool,
}

/// The serde default for boolean options which default to true.
fn default_true() -> bool {
    true
}

/// `status.get` — the working directory status of a repository.
pub async fn status_get(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: GetStatusParams = params_of(params)?;

    let status = git::status::get_status(&state.runner, &params.path, params.include_untracked).await?;

    Ok(json!(status))
}

/// `status.stage` — stage the given files.
pub async fn status_stage(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: FilesParams = params_of(params)?;

    git::status::stage_files(&state.runner, &params.path, &params.files).await?;

    Ok(json!({}))
}

/// `status.unstage` — unstage the given files.
pub async fn status_unstage(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: FilesParams = params_of(params)?;

    git::status::unstage_files(&state.runner, &params.path, &params.files).await?;

    Ok(json!({}))
}

/// Parameters for `status.unstageAll`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnstageAllParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// `status.unstageAll` — clear the index.
pub async fn status_unstage_all(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: UnstageAllParams = params_of(params)?;

    git::status::unstage_all(&state.runner, &params.path).await?;

    Ok(json!({}))
}

/// `status.discard` — discard changes to the given files.
pub async fn status_discard(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: DiscardParams = params_of(params)?;

    git::status::discard_files(
        &state.runner,
        &params.path,
        &params.files,
        params.include_untracked,
    )
    .await?;

    Ok(json!({}))
}
