//! Stash management.
//!
//! Stashes created by this desktop client are marked with a
//! `!!GitHub_Desktop<branch>` message (see [`DESKTOP_STASH_MARKER`]), which is
//! how the legacy engine tags them. Listing therefore walks the reflog of
//! `refs/stash` and keeps only the entries carrying the marker; popping and
//! dropping resolve a stash SHA back to its reflog name (`stash@{0}`).

use super::{split_nul_fields, DESKTOP_STASH_MARKER, GitRunner};
use crate::error::ApiError;
use crate::models::StashEntry;

/// The message prefix that marks a stash as created by this desktop client.
///
/// The full message is `!!GitHub_Desktop<branch>`, mirroring the legacy engine
/// (see `DesktopStashEntryMarker` in `app/src/lib/git/stash.ts`).
pub const DESKTOP_STASH_MESSAGE_PREFIX: &str = "!!GitHub_Desktop<";

/// A raw entry from the `refs/stash` reflog.
struct RawStash {
    /// The reflog selector of the entry, e.g. `stash@{0}`.
    name: String,
    /// The SHA of the stash commit.
    sha: String,
    /// The reflog subject, e.g. `On main: !!GitHub_Desktop<main>`.
    message: String,
}

/// Lists the desktop stashes of a repository.
pub async fn list_stashes(runner: &GitRunner, path: &str) -> Result<Vec<StashEntry>, ApiError> {
    Ok(read_raw_stashes(runner, path)
        .await?
        .into_iter()
        .filter_map(|stash| {
            let branch_name = desktop_stash_branch(&stash.message)?;

            Some(StashEntry {
                name: stash.name,
                branch_name,
                stash_sha: stash.sha,
            })
        })
        .collect())
}

/// Creates a stash, optionally including untracked files.
pub async fn create_stash(
    runner: &GitRunner,
    path: &str,
    branch_name: &str,
    include_untracked: bool,
) -> Result<(), ApiError> {
    let message = format!("{DESKTOP_STASH_MARKER}<{branch_name}>");

    let mut args = vec!["stash".to_string(), "push".to_string()];

    if include_untracked {
        args.push("--include-untracked".to_string());
    }

    args.push("--message".to_string());
    args.push(message);

    // Exit code 1 with "No local changes to save" is not an error for us.
    let output = runner
        .run(crate::git::RunOptions::new(path, &args).success_codes(&[0, 1]))
        .await?;

    if output.code == 1 {
        return Ok(());
    }

    Ok(())
}

/// Applies and drops the stash with the given SHA.
pub async fn pop_stash(runner: &GitRunner, path: &str, stash_sha: &str) -> Result<(), ApiError> {
    let name = resolve_name(runner, path, stash_sha).await?;

    runner
        .run_in(
            path,
            &[
                "stash".to_string(),
                "pop".to_string(),
                "--quiet".to_string(),
                name,
            ],
        )
        .await
        .map(|_| ())
}

/// Drops the stash with the given SHA.
pub async fn drop_stash(runner: &GitRunner, path: &str, stash_sha: &str) -> Result<(), ApiError> {
    let name = resolve_name(runner, path, stash_sha).await?;

    runner
        .run_in(path, &["stash".to_string(), "drop".to_string(), name])
        .await
        .map(|_| ())
}

/// Reads every entry in the `refs/stash` reflog, desktop ones or not.
async fn read_raw_stashes(runner: &GitRunner, path: &str) -> Result<Vec<RawStash>, ApiError> {
    let output = runner
        .run_in_with(
            path,
            &[
                "log".to_string(),
                "-g".to_string(),
                "-z".to_string(),
                // `git log` uses `%x00` for NUL (as opposed to for-each-ref's
                // `%00`), see `git help log`.
                "--format=%gD%x00%H%x00%gs%x00%T%x00%P".to_string(),
                "refs/stash".to_string(),
                "--".to_string(),
            ],
            &[0, 128],
        )
        .await?;

    // There is no refs/stash in this repository (or it has no reflog).
    if output.code == 128 {
        return Ok(Vec::new());
    }

    // Empty fields are significant, so the tokens can't be filtered.
    let tokens = split_nul_fields(&output.stdout_str());
    let mut stashes = Vec::new();

    for record in tokens.chunks(5) {
        if record.len() < 5 {
            continue;
        }

        stashes.push(RawStash {
            name: record[0].clone(),
            sha: record[1].clone(),
            message: record[2].clone(),
        });
    }

    Ok(stashes)
}

/// Finds the reflog name of the stash with the given SHA.
async fn resolve_name(runner: &GitRunner, path: &str, stash_sha: &str) -> Result<String, ApiError> {
    let stashes = read_raw_stashes(runner, path).await?;

    stashes
        .iter()
        .find(|stash| stash.sha == stash_sha)
        .map(|stash| stash.name.clone())
        .ok_or_else(|| ApiError::not_found(format!("stash not found: {stash_sha}")))
}

/// Extracts the branch name out of a desktop stash message.
///
/// Desktop messages look like `!!GitHub_Desktop<branch>`; git prefixes them
/// with `On <branch>: ` in the reflog subject.
fn desktop_stash_branch(message: &str) -> Option<String> {
    let start = message.find(DESKTOP_STASH_MESSAGE_PREFIX)?
        + DESKTOP_STASH_MESSAGE_PREFIX.len();

    let branch = message[start..].strip_suffix('>')?;

    Some(branch.to_string()).filter(|branch| !branch.is_empty())
}
