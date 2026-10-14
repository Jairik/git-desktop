//! Continuous-integration status, built thinly on `gh`.
//!
//! [`status`] combines two GitHub sources for a commit — check runs
//! (`/commits/<ref>/check-runs`) and legacy commit statuses
//! (`/commits/<ref>/statuses`) — into a [`crate::models::CiStatus`] with a
//! rolled-up conclusion.

use serde::Deserialize;

use super::{GhOptions, GhRunner};
use crate::error::ApiError;
use crate::git::{reject_option, GitRunner};
use crate::models::{Check, CiStatus};

/// The `gh api … --jq` expression projecting a check run onto the fields of a
/// [`Check`]. Emits one compact JSON object per line (NDJSON).
const CHECK_RUNS_JQ: &str =
    r#".check_runs[] | {name, status, conclusion, details_url: .details_url, started_at, completed_at, kind: "check_run"}"#;

/// The `gh api … --jq` expression projecting a commit status onto a [`Check`].
///
/// The `/statuses` endpoint returns a bare array, so the stream is `.[]` (not
/// `.statuses[]`). Legacy statuses are always terminal, hence the fixed
/// `"completed"` status and the mapped conclusion.
const STATUSES_JQ: &str =
    r#".[] | {name: .context, status: "completed", conclusion: .state, details_url: .target_url, started_at: null, completed_at: .updated_at, kind: "status"}"#;

/// A single NDJSON record emitted by [`CHECK_RUNS_JQ`] / [`STATUSES_JQ`].
///
/// gh renders snake_case keys here, so this struct deliberately does *not* use
/// `rename_all`; the fields are mapped (and case-normalized) into [`Check`]
/// below.
#[derive(Debug, Deserialize)]
struct RawCheck {
    name: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    details_url: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
    kind: String,
}

impl RawCheck {
    /// Builds a [`Check`], lower-casing the status/conclusion defensively.
    fn into_check(self) -> Check {
        Check {
            name: self.name,
            status: self.status.unwrap_or_default().to_ascii_lowercase(),
            conclusion: self.conclusion.map(|value| value.to_ascii_lowercase()),
            details_url: self.details_url,
            started_at: self.started_at,
            completed_at: self.completed_at,
            kind: self.kind,
        }
    }
}

/// `ci.status` — the combined check-runs + commit-statuses for `ref`.
///
/// `reference` is the ref to inspect; when `None`, the repository's current
/// branch is used (or `HEAD` when detached). The ref is passed to the GitHub API
/// verbatim (GitHub resolves branch names and `HEAD` itself); `head_sha` is the
/// ref resolved locally, and is `null` when that resolution fails.
pub async fn status(
    gh: &GhRunner,
    git: &GitRunner,
    path: &str,
    owner: &str,
    repo: &str,
    reference: Option<&str>,
) -> Result<CiStatus, ApiError> {
    // The ref handed to the GitHub API: the caller's ref verbatim, else the
    // current branch (or "HEAD" when detached).
    let api_ref = match reference {
        Some(reference) => reference.to_string(),
        None => current_branch_or_head(git, path).await,
    };

    // The ref is interpolated into the `gh api repos/…/commits/<ref>/…` URL
    // path, so reject anything git/gh would treat specially (empty, or a
    // leading `-`, which `gh` could read as an option).
    reject_option(&api_ref)?;

    // The local resolution of the same ref, for the reported head SHA.
    let head_sha = resolve_sha(git, path, &api_ref).await;

    let repo_prefix = format!("repos/{owner}/{repo}/commits/{api_ref}");

    let check_runs = match gh
        .run_ndjson(GhOptions::new(vec![
            "api".to_string(),
            format!("{repo_prefix}/check-runs"),
            "--jq".to_string(),
            CHECK_RUNS_JQ.to_string(),
        ]))
        .await
    {
        Ok(nd) => nd
            .into_iter()
            .filter_map(|value| serde_json::from_value::<RawCheck>(value).ok())
            .map(RawCheck::into_check)
            .collect::<Vec<_>>(),
        // A branch with no commit on the remote yet (e.g. a purely-local,
        // never-pushed branch) has no CI at all — report it as empty rather
        // than surfacing a spurious gh_error to the client.
        Err(err) if is_no_commit_on_remote(&err) => {
            return Ok(CiStatus {
                head_sha,
                roll_up: "pending".to_string(),
                checks: Vec::new(),
            });
        }
        Err(err) => return Err(err),
    };

    // The combined runs come first, then the legacy commit statuses.
    let statuses = gh
        .run_ndjson(GhOptions::new(vec![
            "api".to_string(),
            format!("{repo_prefix}/statuses"),
            "--jq".to_string(),
            STATUSES_JQ.to_string(),
        ]))
        .await?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<RawCheck>(value).ok())
        .map(RawCheck::into_check)
        .collect::<Vec<_>>();

    let mut checks = check_runs;
    checks.extend(statuses);

    let roll_up = roll_up(&checks);

    Ok(CiStatus {
        head_sha,
        roll_up,
        checks,
    })
}

/// The current branch name, or `HEAD` when detached / unresolvable.
async fn current_branch_or_head(git: &GitRunner, path: &str) -> String {
    match git.run_in(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok(output) => {
            let branch = output.stdout_str().trim().to_string();
            if branch.is_empty() {
                "HEAD".to_string()
            } else {
                branch
            }
        }
        Err(_) => "HEAD".to_string(),
    }
}

/// Resolves `reference` to a full SHA locally, or `None` if that fails.
async fn resolve_sha(git: &GitRunner, path: &str, reference: &str) -> Option<String> {
    let output = git.run_in(path, &["rev-parse", reference]).await.ok()?;
    let sha = output.stdout_str().trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// Whether an error means the ref has no commit on GitHub yet (e.g. a
/// purely-local, never-pushed branch). GitHub answers 422 with "No commit
/// found"; that is "no CI", not a failure.
fn is_no_commit_on_remote(err: &ApiError) -> bool {
    err.to_string().to_ascii_lowercase().contains("no commit found")
}

/// Folds the checks into a single `roll_up`.
///
/// Per the contract: any non-completed check → `pending`; else any failing
/// conclusion → `failure`; else no checks → `pending`; else `success`.
fn roll_up(checks: &[Check]) -> String {
    if checks.iter().any(|check| check.status != "completed") {
        return "pending".to_string();
    }

    if checks.iter().any(is_failing) {
        return "failure".to_string();
    }

    if checks.is_empty() {
        return "pending".to_string();
    }

    "success".to_string()
}

/// Whether a completed check ended in a non-success conclusion.
fn is_failing(check: &Check) -> bool {
    matches!(
        check.conclusion.as_deref(),
        Some("failure")
            | Some("timed_out")
            | Some("cancelled")
            | Some("action_required")
            | Some("error")
    )
}
