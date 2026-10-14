//! Tag management.

use std::collections::BTreeMap;

use super::{reject_option, GitRunner};
use crate::error::ApiError;

/// Lists the tags of a repository, keyed on tag name.
pub async fn list_tags(runner: &GitRunner, path: &str) -> Result<BTreeMap<String, String>, ApiError> {
    let output = runner
        .run_in(
            path,
            &[
                "for-each-ref".to_string(),
                "--format=%(refname:short)%00%(objectname)".to_string(),
                "refs/tags".to_string(),
            ],
        )
        .await?;

    let mut tags = BTreeMap::new();

    for line in output.stdout_str().lines() {
        let Some((name, sha)) = line.split_once('\0') else {
            continue;
        };

        tags.insert(name.to_string(), sha.to_string());
    }

    Ok(tags)
}

/// Creates an annotated tag pointing at the given commit.
pub async fn create_tag(
    runner: &GitRunner,
    path: &str,
    name: &str,
    target_commit_sha: &str,
) -> Result<(), ApiError> {
    reject_option(name)?;
    reject_option(target_commit_sha)?;

    runner
        .run_in(
            path,
            &[
                "tag".to_string(),
                "-a".to_string(),
                "-m".to_string(),
                name.to_string(),
                name.to_string(),
                target_commit_sha.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Deletes a tag.
pub async fn delete_tag(runner: &GitRunner, path: &str, name: &str) -> Result<(), ApiError> {
    runner
        .run_in(path, &["tag".to_string(), "-d".to_string(), name.to_string()])
        .await
        .map(|_| ())
}
