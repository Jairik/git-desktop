//! Branch handlers: `branch.list`, `branch.create`, `branch.rename`,
//! `branch.delete`, `branch.checkout`, `commit.checkout` and
//! `branch.aheadBehind`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::models::{Branch, BranchType};
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `branch.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchListParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `branch.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreateParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the new branch.
    pub name: String,
    /// The commit the branch should start from.
    #[serde(default)]
    pub start_point: Option<String>,
    /// Whether the branch should not track its start point.
    #[serde(default)]
    pub no_track: bool,
}

/// Parameters for `branch.rename`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRenameParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The current name of the branch.
    pub name: String,
    /// The new name of the branch.
    pub new_name: String,
}

/// Parameters for `branch.delete`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The branch to delete.
    pub branch: Branch,
}

/// Parameters for `branch.checkout`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheckoutParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the branch to check out.
    pub name: String,
}

/// Parameters for `commit.checkout`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCheckoutParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The SHA of the commit to check out.
    pub sha: String,
}

/// Parameters for `branch.aheadBehind`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehindParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The branch and its upstream.
    pub branch: AheadBehindBranch,
}

/// The `{ name, upstream }` payload of `branch.aheadBehind`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehindBranch {
    /// The name of the branch.
    pub name: String,
    /// The upstream ref of the branch.
    pub upstream: String,
}

/// `branch.list` — the local and remote branches of a repository.
pub async fn branch_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: BranchListParams = params_of(params)?;

    let branches = git::branch::list_branches(&state.runner, &params.path).await?;

    Ok(json!(branches))
}

/// `branch.create` — create a branch.
pub async fn branch_create(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: BranchCreateParams = params_of(params)?;

    git::branch::create_branch(
        &state.runner,
        &params.path,
        &params.name,
        params.start_point.as_deref(),
        params.no_track,
    )
    .await?;

    Ok(json!({}))
}

/// `branch.rename` — rename a branch.
pub async fn branch_rename(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: BranchRenameParams = params_of(params)?;

    git::branch::rename_branch(&state.runner, &params.path, &params.name, &params.new_name).await?;

    Ok(json!({}))
}

/// `branch.delete` — delete a local or remote branch.
pub async fn branch_delete(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: BranchDeleteParams = params_of(params)?;

    if params.branch.branch_type == BranchType::Remote
        && !params.branch.name.contains('/')
    {
        return Err(ApiError::bad_request(format!(
            "not a remote branch: {}",
            params.branch.name
        )));
    }

    git::branch::delete_branch(&state.runner, &params.path, &params.branch).await?;

    Ok(json!({}))
}

/// `branch.checkout` — check out a branch.
pub async fn branch_checkout(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: BranchCheckoutParams = params_of(params)?;

    git::branch::checkout_branch(&state.runner, &params.path, &params.name).await?;

    Ok(json!({}))
}

/// `commit.checkout` — check out a commit in a detached HEAD.
pub async fn commit_checkout(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CommitCheckoutParams = params_of(params)?;

    git::branch::checkout_commit(&state.runner, &params.path, &params.sha).await?;

    Ok(json!({}))
}

/// `branch.aheadBehind` — how far a branch is from its upstream.
pub async fn branch_ahead_behind(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: AheadBehindParams = params_of(params)?;

    let ahead_behind = git::branch::ahead_behind(
        &state.runner,
        &params.path,
        &params.branch.name,
        &params.branch.upstream,
    )
    .await?;

    Ok(json!(ahead_behind))
}
