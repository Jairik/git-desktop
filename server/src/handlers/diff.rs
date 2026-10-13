//! Diff handlers: `diff.workingDirectory`, `diff.commit`, `diff.stash` and
//! `image.workingDirectory`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::git::diff::FileRefParams;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `diff.workingDirectory`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDirectoryDiffParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The file to diff.
    pub file: FileRefParams,
    /// Whether to ignore whitespace changes (defaults to false).
    #[serde(default)]
    pub hide_whitespace: bool,
}

/// Parameters for `diff.commit`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiffParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The file to diff.
    pub file: FileRefParams,
    /// The commit (or committish) to diff.
    pub commitish: String,
}

/// Parameters for `diff.stash`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDiffParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA of the stash entry.
    pub stash_sha: String,
    /// The file to diff.
    pub file: FileRefParams,
}

/// Parameters for `image.workingDirectory`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The file to read the image data from.
    pub file: FileRefParams,
}

/// `diff.workingDirectory` — diff a file against HEAD (or the index).
pub async fn diff_working_directory(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: WorkingDirectoryDiffParams = params_of(params)?;

    let diff = git::diff::working_directory_diff(
        &state.runner,
        &params.path,
        &params.file.into(),
        params.hide_whitespace,
    )
    .await?;

    Ok(json!(diff))
}

/// `diff.commit` — diff a file as changed by a commit.
pub async fn diff_commit(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CommitDiffParams = params_of(params)?;

    let file = params.file.into();

    let diff = git::diff::commit_diff(&state.runner, &params.path, &file, &params.commitish).await?;

    Ok(json!(diff))
}

/// `diff.stash` — diff a file as recorded in a stash entry.
pub async fn diff_stash(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: StashDiffParams = params_of(params)?;

    let file = params.file.into();

    let diff = git::diff::stash_diff(&state.runner, &params.path, &params.stash_sha, &file).await?;

    Ok(json!(diff))
}

/// `image.workingDirectory` — the current and previous image of a file.
pub async fn image_working_directory(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ImageParams = params_of(params)?;

    let diff = git::diff::working_directory_image_diff(
        &state.runner,
        &params.path,
        &params.file.into(),
    )
    .await?;

    Ok(json!(diff))
}
