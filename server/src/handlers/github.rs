//! GitHub handlers — the thin JSON-RPC surface over the `gh` CLI.
//!
//! Each function applies the shared preconditions and delegates to the
//! [`crate::github`] execution layer:
//!
//! - [`require_auth`] maps "gh missing/unauthenticated" to `auth_required`;
//! - [`require_repo`] maps "origin is not a GitHub remote" / "no remote" to
//!   `not_found`;
//! - the `github` module maps every other non-zero `gh` exit to `gh_error`
//!   (carrying `data.stderr`).
//!
//! Adding a method here is a matter of adding one such thin fn and registering
//! its name in the dispatch table in [`crate::rpc`].

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::github::{self, GhRunner};
use crate::models::{CiStatus, GitHubRemote, GitHubStatus, PullRequest, PullRequestDetail};
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters carrying just a repository path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `pr.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The gh state filter (`open`, `closed`, `merged`, `all`).
    #[serde(default = "default_state")]
    pub state: String,
    /// How many pull requests to return.
    #[serde(default = "default_limit")]
    pub limit: i64,
    /// Filter to PRs whose head branch is this name.
    #[serde(default)]
    pub branch: Option<String>,
}

/// Parameters for `pr.view` and `pr.checkout`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrNumberParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The pull request number.
    pub number: i64,
}

/// Parameters for `ci.status`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiStatusParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The ref to inspect; defaults to the current branch (or `HEAD`).
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

/// The default `pr.list` state filter.
fn default_state() -> String {
    "open".to_string()
}

/// The default `pr.list` page size.
fn default_limit() -> i64 {
    30
}

/// Ensures the `gh` CLI is installed and authenticated, else `auth_required`.
pub(crate) async fn require_auth(gh: &GhRunner) -> Result<(), ApiError> {
    if !gh.gh_available().await {
        return Err(ApiError::auth_required("the gh CLI is not installed"));
    }

    if !gh.gh_authenticated().await {
        return Err(ApiError::auth_required(
            "the gh CLI is not authenticated; run `gh auth login`",
        ));
    }

    Ok(())
}

/// Resolves a repository's origin into `(owner, repo)`, mapping a missing or
/// non-GitHub origin to `not_found`.
pub(crate) async fn require_repo(state: &AppState, path: &str) -> Result<(String, String), ApiError> {
    match github::origin_owner_repo(&state.runner, path).await? {
        Some((owner, repo, _hostname)) => Ok((owner, repo)),
        None => Err(ApiError::not_found(
            "origin is not a GitHub remote; cannot use GitHub methods",
        )),
    }
}

/// `github.status` — whether the `gh` CLI can be used. Always succeeds.
pub async fn github_status(state: &AppState, _params: Value) -> Result<Value, ApiError> {
    let available = state.gh.gh_available().await;
    let authenticated = state.gh.gh_authenticated().await;
    let user = state.gh.gh_user().await;

    Ok(json!(GitHubStatus {
        available,
        authenticated,
        user,
    }))
}

/// `github.remote` — the parsed origin, or `null` when it isn't a GitHub remote.
pub async fn github_remote(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PathParams = params_of(params)?;

    require_auth(&state.gh).await?;

    match github::origin_owner_repo(&state.runner, &params.path).await? {
        Some((owner, name, hostname)) => Ok(json!(GitHubRemote {
            owner,
            name,
            hostname
        })),
        None => Ok(Value::Null),
    }
}

/// `pr.list` — the pull requests visible to the authenticated user.
pub async fn pr_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PrListParams = params_of(params)?;

    require_auth(&state.gh).await?;
    let (owner, repo) = require_repo(state, &params.path).await?;

    let pull_requests: Vec<PullRequest> = github::pr::list(
        &state.gh,
        &owner,
        &repo,
        &params.state,
        params.limit,
        params.branch.as_deref(),
    )
    .await?;

    Ok(json!(pull_requests))
}

/// `pr.view` — the detail of one pull request, or `null` when it doesn't exist.
pub async fn pr_view(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PrNumberParams = params_of(params)?;

    require_auth(&state.gh).await?;
    let (owner, repo) = require_repo(state, &params.path).await?;

    let detail: Option<PullRequestDetail> =
        github::pr::view(&state.gh, &owner, &repo, params.number).await?;

    Ok(json!(detail))
}

/// `pr.checkout` — check out a PR's branch; returns the branch now checked out.
pub async fn pr_checkout(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PrNumberParams = params_of(params)?;

    require_auth(&state.gh).await?;
    let (owner, repo) = require_repo(state, &params.path).await?;

    let branch = github::pr::checkout(
        &state.gh,
        &state.runner,
        &params.path,
        &owner,
        &repo,
        params.number,
    )
    .await?;

    Ok(json!({ "branch": branch }))
}

/// `ci.status` — the combined CI status for a ref (default: current branch).
pub async fn ci_status(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CiStatusParams = params_of(params)?;

    require_auth(&state.gh).await?;
    let (owner, repo) = require_repo(state, &params.path).await?;

    let status: CiStatus = github::ci::status(
        &state.gh,
        &state.runner,
        &params.path,
        &owner,
        &repo,
        params.reference.as_deref(),
    )
    .await?;

    Ok(json!(status))
}
