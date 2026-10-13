//! Stash handlers: `stash.list`, `stash.create`, `stash.pop` and `stash.drop`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `stash.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashListParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `stash.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashCreateParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The branch the stash belongs to (recorded in the stash message).
    pub branch_name: String,
    /// Whether untracked files should be stashed (defaults to true).
    #[serde(default = "default_true")]
    pub include_untracked: bool,
}

/// Parameters for `stash.pop` and `stash.drop`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashShaParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA of the stash entry.
    pub stash_sha: String,
}

/// The serde default for boolean options which default to true.
fn default_true() -> bool {
    true
}

/// `stash.list` — the stashes created by this desktop client.
pub async fn stash_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: StashListParams = params_of(params)?;

    let stashes = git::stash::list_stashes(&state.runner, &params.path).await?;

    Ok(json!(stashes))
}

/// `stash.create` — stash the working directory.
pub async fn stash_create(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: StashCreateParams = params_of(params)?;

    git::stash::create_stash(
        &state.runner,
        &params.path,
        &params.branch_name,
        params.include_untracked,
    )
    .await?;

    Ok(json!({}))
}

/// `stash.pop` — apply and drop a stash.
pub async fn stash_pop(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: StashShaParams = params_of(params)?;

    git::stash::pop_stash(&state.runner, &params.path, &params.stash_sha).await?;

    Ok(json!({}))
}

/// `stash.drop` — drop a stash.
pub async fn stash_drop(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: StashShaParams = params_of(params)?;

    git::stash::drop_stash(&state.runner, &params.path, &params.stash_sha).await?;

    Ok(json!({}))
}
