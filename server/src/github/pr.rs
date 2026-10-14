//! Pull-request operations built thinly on `gh`.
//!
//! Each function derives `owner/repo` from the caller (already resolved via
//! [`super::origin_owner_repo`]) and runs the matching `gh pr` command, parsing
//! its `--json` output into the shapes from [`crate::models`].

use serde::Deserialize;
use serde_json::Value;

use super::{is_pr_not_found, GhOptions, GhRunner};
use crate::error::ApiError;
use crate::git::GitRunner;
use crate::models::{Author, PullRequest, PullRequestDetail};

/// The `gh pr list`/`gh pr view` field list (shared; view reads the extra
/// detail fields from the same struct, which default when absent).
const PR_FIELDS: &str = "number,title,state,isDraft,url,headRefName,baseRefName,author,createdAt,updatedAt,additions,deletions,changedFiles,mergeable";

/// The extra fields `gh pr view` adds on top of [`PR_FIELDS`].
const PR_VIEW_FIELDS: &str = "body,comments,reviewDecision,headRefOid";

/// The raw shape `gh pr … --json …` emits (camelCase, matching the flag names).
///
/// The detail-only fields (`body`, `comments`, `review_decision`,
/// `head_ref_oid`) are absent for `pr list` and default to `None`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    number: i64,
    title: String,
    state: String,
    is_draft: bool,
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    author: Option<Author>,
    created_at: String,
    updated_at: String,
    additions: i64,
    deletions: i64,
    changed_files: i64,
    mergeable: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    comments: Option<Value>,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    head_ref_oid: Option<String>,
}

impl RawPullRequest {
    /// Builds the shared [`PullRequest`], normalizing the state casing.
    fn into_pull_request(self) -> PullRequest {
        PullRequest {
            number: self.number,
            title: self.title,
            state: normalize_state(&self.state),
            is_draft: self.is_draft,
            url: self.url,
            head_ref_name: self.head_ref_name,
            base_ref_name: self.base_ref_name,
            author: self.author,
            created_at: self.created_at,
            updated_at: self.updated_at,
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            mergeable: non_empty(self.mergeable),
        }
    }

    /// Builds a [`PullRequestDetail`], folding the detail-only fields in.
    fn into_detail(self) -> PullRequestDetail {
        // Read the detail-only fields before `into_pull_request` consumes `self`.
        let body = self.body.clone().unwrap_or_default();
        let comments = comment_count(self.comments.clone());
        let review_decision = non_empty(self.review_decision.clone());
        let head_sha = non_empty(self.head_ref_oid.clone());

        PullRequestDetail {
            base: self.into_pull_request(),
            body,
            comments,
            review_decision,
            head_sha,
        }
    }
}

/// `pr.list` — the pull requests of `owner/repo`.
///
/// `state` is gh's state filter (`open`, `closed`, `merged`, `all`); `branch`
/// filters by head branch when provided.
pub async fn list(
    gh: &GhRunner,
    owner: &str,
    repo: &str,
    state: &str,
    limit: i64,
    branch: Option<&str>,
) -> Result<Vec<PullRequest>, ApiError> {
    let mut args = vec![
        "pr".to_string(),
        "list".to_string(),
        "--repo".to_string(),
        format!("{owner}/{repo}"),
        "--state".to_string(),
        state.to_string(),
        "--limit".to_string(),
        limit.to_string(),
        "--json".to_string(),
        PR_FIELDS.to_string(),
    ];

    if let Some(branch) = branch {
        args.push("--head".to_string());
        args.push(branch.to_string());
    }

    let value = gh.run_json(GhOptions::new(args)).await?;
    let items: Vec<RawPullRequest> = serde_json::from_value(value)
        .map_err(|error| ApiError::internal(format!("failed to parse gh pr list output: {error}")))?;

    Ok(items.into_iter().map(RawPullRequest::into_pull_request).collect())
}

/// `pr.view` — the detail of one pull request, or `null` when it doesn't exist.
pub async fn view(
    gh: &GhRunner,
    owner: &str,
    repo: &str,
    number: i64,
) -> Result<Option<PullRequestDetail>, ApiError> {
    let args = vec![
        "pr".to_string(),
        "view".to_string(),
        number.to_string(),
        "--repo".to_string(),
        format!("{owner}/{repo}"),
        "--json".to_string(),
        format!("{PR_FIELDS},{PR_VIEW_FIELDS}"),
    ];

    let output = match gh.run(GhOptions::new(args)).await {
        Ok(output) => output,
        // A missing PR is reported as `null`, not as an error.
        Err(error) if is_pr_not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };

    let raw: RawPullRequest = serde_json::from_str(output.stdout.trim())
        .map_err(|error| ApiError::internal(format!("failed to parse gh pr view output: {error}")))?;

    Ok(Some(raw.into_detail()))
}

/// `pr.checkout` — check out a PR's branch in the repository at `path`.
///
/// `gh pr checkout` needs a working tree, so it runs with the process cwd set
/// to `path`. Returns the name of the branch now checked out (`HEAD` when HEAD
/// is detached).
pub async fn checkout(
    gh: &GhRunner,
    git: &GitRunner,
    path: &str,
    owner: &str,
    repo: &str,
    number: i64,
) -> Result<String, ApiError> {
    let args = vec![
        "pr".to_string(),
        "checkout".to_string(),
        number.to_string(),
        "--repo".to_string(),
        format!("{owner}/{repo}"),
    ];

    gh.run(GhOptions::in_dir(path, args)).await?;

    // `--abbrev-ref HEAD` returns "HEAD" when the checkout is detached, which
    // is exactly the contract's detached sentinel.
    let output = git
        .run_in(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?;

    Ok(output.stdout_str().trim().to_string())
}

/// Normalizes gh's uppercase state (`OPEN`/`CLOSED`/`MERGED`) to lower case.
fn normalize_state(state: &str) -> String {
    state.to_ascii_lowercase()
}

/// Maps `Some("")`/whitespace to `None`, keeping real values.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

/// Extracts a comment count from gh's `comments` field, which is an array in
/// current gh versions, an object with `.totalCount` in some others, and a bare
/// number in yet others.
fn comment_count(comments: Option<Value>) -> i64 {
    match comments {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::Array(items)) => items.len() as i64,
        Some(Value::Object(object)) => object
            .get("totalCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        _ => 0,
    }
}
