//! Repository configuration and author identity.

use super::GitRunner;
use crate::error::ApiError;
use crate::git::commit::parse_commit_identity;
use crate::models::CommitIdentity;

/// Reads a config value, returning `None` when it isn't set.
///
/// When `path` is omitted the global config is read.
pub async fn get_config_value(
    runner: &GitRunner,
    path: Option<&str>,
    name: &str,
    only_local: bool,
) -> Result<Option<String>, ApiError> {
    let args = vec![
        "config".to_string(),
        config_scope(path, only_local),
        "--get".to_string(),
        name.to_string(),
    ];

    let output = match path {
        Some(path) => runner.run_in_with(path, &args, &[0, 1]).await?,
        None => runner.run_global(&args, Some(&[0, 1])).await?,
    };

    if output.code == 1 {
        return Ok(None);
    }

    let value = output.stdout_str();
    let value = value.trim_end_matches('\n').to_string();

    Ok(Some(value))
}

/// Writes a config value.
pub async fn set_config_value(
    runner: &GitRunner,
    path: Option<&str>,
    name: &str,
    value: &str,
    only_local: bool,
) -> Result<(), ApiError> {
    let args = vec![
        "config".to_string(),
        config_scope(path, only_local),
        name.to_string(),
        value.to_string(),
    ];

    match path {
        Some(path) => runner.run_in_with(path, &args, &[0]).await,
        None => runner.run_global(&args, Some(&[0])).await,
    }
    .map(|_| ())
}

/// The `--local`/`--global` flag for a config call.
fn config_scope(path: Option<&str>, only_local: bool) -> String {
    if only_local || path.is_some() {
        "--local".to_string()
    } else {
        "--global".to_string()
    }
}

/// Reads the author identity git would use for a commit in this repository.
///
/// Returns `None` when no identity is configured and git refuses to guess.
pub async fn get_author_identity(
    runner: &GitRunner,
    path: &str,
) -> Result<Option<CommitIdentity>, ApiError> {
    let output = runner
        .run_in_with(path, &["var".to_string(), "GIT_AUTHOR_IDENT".to_string()], &[0, 128])
        .await?;

    if output.code == 128 {
        // user.useconfigonly is set and no name/email is configured.
        return Ok(None);
    }

    Ok(parse_commit_identity(&output.stdout_str()))
}
