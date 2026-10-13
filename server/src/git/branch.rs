//! Branch listing and manipulation.

use super::GitRunner;
use crate::error::ApiError;
use crate::models::{AheadBehind, Branch, BranchType, Tip};

/// Lists the local and remote branches of a repository.
pub async fn list_branches(runner: &GitRunner, path: &str) -> Result<Vec<Branch>, ApiError> {
    let output = runner
        .run_in(
            path,
            &[
                "for-each-ref".to_string(),
                "--format=%(refname)%00%(objectname)%00%(upstream)".to_string(),
                "refs/heads".to_string(),
                "refs/remotes".to_string(),
            ],
        )
        .await?;

    let mut branches = Vec::new();

    for line in output.stdout_str().lines() {
        let mut fields = line.split('\0');

        let Some(reference) = fields.next() else {
            continue;
        };
        let reference = reference.to_string();

        let sha = fields.next().unwrap_or_default().to_string();
        let upstream = fields
            .next()
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());

        let Some((branch_type, name)) = split_ref(&reference) else {
            continue;
        };

        branches.push(Branch {
            name,
            ref_: reference,
            upstream,
            tip: Tip { sha },
            branch_type,
        });
    }

    Ok(branches)
}

/// Splits `refs/heads/<name>` / `refs/remotes/<name>` into type and short name.
fn split_ref(reference: &str) -> Option<(BranchType, String)> {
    if let Some(name) = reference.strip_prefix("refs/heads/") {
        Some((BranchType::Local, name.to_string()))
    } else if let Some(name) = reference.strip_prefix("refs/remotes/") {
        Some((BranchType::Remote, name.to_string()))
    } else {
        None
    }
}

/// Creates a branch, optionally from a start point and without tracking.
pub async fn create_branch(
    runner: &GitRunner,
    path: &str,
    name: &str,
    start_point: Option<&str>,
    no_track: bool,
) -> Result<(), ApiError> {
    let mut args = vec!["branch".to_string()];

    if no_track {
        args.push("--no-track".to_string());
    }

    args.push("--".to_string());
    args.push(name.to_string());

    if let Some(start_point) = start_point {
        args.push(start_point.to_string());
    }

    runner.run_in_vec(path, args).await.map(|_| ())
}

/// Renames a branch.
pub async fn rename_branch(runner: &GitRunner, path: &str, name: &str, new_name: &str) -> Result<(), ApiError> {
    runner
        .run_in(path, &["branch".to_string(), "-m".to_string(), name.to_string(), new_name.to_string()])
        .await
        .map(|_| ())
}

/// Deletes a local branch, or a remote branch by pushing a delete.
pub async fn delete_branch(
    runner: &GitRunner,
    path: &str,
    branch: &Branch,
) -> Result<(), ApiError> {
    match branch.branch_type {
        BranchType::Local => {
            runner
                .run_in(
                    path,
                    &["branch".to_string(), "-D".to_string(), branch.name.clone()],
                )
                .await
                .map(|_| ())
        }
        BranchType::Remote => {
            let (remote, name) = branch
                .name
                .split_once('/')
                .ok_or_else(|| ApiError::bad_request(format!("invalid remote branch: {}", branch.name)))?;

            runner
                .run_in(
                    path,
                    &[
                        "push".to_string(),
                        "--".to_string(),
                        remote.to_string(),
                        format!(":{name}"),
                    ],
                )
                .await
                .map(|_| ())
        }
    }
}

/// Checks out a branch by name.
pub async fn checkout_branch(runner: &GitRunner, path: &str, name: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "-c".to_string(),
                "advice.detachedHead=false".to_string(),
                "checkout".to_string(),
                name.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Checks out a commit, detaching HEAD.
pub async fn checkout_commit(runner: &GitRunner, path: &str, sha: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "-c".to_string(),
                "advice.detachedHead=false".to_string(),
                "checkout".to_string(),
                "--detach".to_string(),
                sha.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Computes how many commits a branch is ahead/behind its upstream.
pub async fn ahead_behind(
    runner: &GitRunner,
    path: &str,
    branch: &str,
    upstream: &str,
) -> Result<AheadBehind, ApiError> {
    let range = format!("{branch}...{upstream}");

    // The three dot form means git goes back to the merge base of the two refs.
    let output = runner
        .run_in(
            path,
            &[
                "rev-list".to_string(),
                "--left-right".to_string(),
                "--count".to_string(),
                "--end-of-options".to_string(),
                range,
                "--".to_string(),
            ],
        )
        .await?;

    let stdout = output.stdout_str();
    let mut pieces = stdout.split('\t');
    let ahead = pieces
        .next()
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| ApiError::internal("unable to parse rev-list output"))?;
    let behind = pieces
        .next()
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| ApiError::internal("unable to parse rev-list output"))?;

    Ok(AheadBehind { ahead, behind })
}
