//! Network handlers: `fetch`, `pull`, `push` and `clone`.
//!
//! Each of these emits progress on the matching WebSocket event while the git
//! command runs, and still returns the final result to the caller.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;
use crate::store;

/// Parameters for `fetch`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The remote to fetch from; all remotes when omitted.
    #[serde(default)]
    pub remote: Option<String>,
    /// Whether to prune deleted remote branches.
    #[serde(default)]
    pub prune_background: bool,
}

/// Parameters for `pull`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The remote to pull from.
    #[serde(default)]
    pub remote: Option<String>,
}

/// Parameters for `push`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The remote to push to.
    pub remote: String,
    /// The local branch to push.
    pub local_branch: String,
    /// The remote branch to push to; defaults to the local branch name.
    #[serde(default)]
    pub remote_branch: Option<String>,
    /// Tags to push along with the branch.
    #[serde(default)]
    pub tags_to_push: Vec<String>,
    /// Whether to force-push with a lease.
    #[serde(default)]
    pub force_with_lease: bool,
}

/// The branch options for `clone`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOptions {
    /// The branch to check out after cloning.
    #[serde(default)]
    pub branch: Option<String>,
    /// The branch to use as the default when the repo is empty.
    #[serde(default)]
    pub default_branch: Option<String>,
}

/// Parameters for `clone`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneParams {
    /// The URL to clone from.
    pub url: String,
    /// The path to clone into.
    pub path: String,
    /// Extra clone options.
    #[serde(default)]
    pub options: Option<CloneOptions>,
}

/// `fetch` — fetch from one remote, or from all remotes.
pub async fn fetch(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: FetchParams = params_of(params)?;

    git::network::fetch(
        &state.runner,
        &params.path,
        params.remote.as_deref(),
        params.prune_background,
        &state.events,
    )
    .await?;

    Ok(json!({}))
}

/// `pull` — pull from a remote.
pub async fn pull(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PullParams = params_of(params)?;

    git::network::pull(
        &state.runner,
        &params.path,
        params.remote.as_deref(),
        &state.events,
    )
    .await?;

    Ok(json!({}))
}

/// `push` — push a branch (and optionally tags) to a remote.
pub async fn push(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PushParams = params_of(params)?;

    git::network::push(
        &state.runner,
        &params.path,
        &params.remote,
        &params.local_branch,
        params.remote_branch.as_deref(),
        &params.tags_to_push,
        params.force_with_lease,
        &state.events,
    )
    .await?;

    Ok(json!({}))
}

/// `clone` — clone a repository and register it in the store.
pub async fn clone(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CloneParams = params_of(params)?;

    let options = params.options.clone();

    git::network::clone(
        &state.runner,
        &params.url,
        &params.path,
        options.as_ref().and_then(|options| options.branch.as_deref()),
        options
            .as_ref()
            .and_then(|options| options.default_branch.as_deref()),
        &state.events,
    )
    .await?;

    let entry = state.lock_store().upsert(&params.path, None);

    state.persist();

    Ok(json!(store::to_repository(&entry)))
}
