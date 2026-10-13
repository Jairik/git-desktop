//! Remote management.

use super::GitRunner;
use crate::error::ApiError;
use crate::models::Remote;

/// Lists the remotes of a repository.
pub async fn list_remotes(runner: &GitRunner, path: &str) -> Result<Vec<Remote>, ApiError> {
    let output = runner
        .run_in(path, &["remote".to_string(), "--verbose".to_string()])
        .await?;

    let mut remotes: Vec<Remote> = Vec::new();

    // `git remote --verbose` prints "<name>\t<url> (push|fetch)" per line; every
    // remote appears twice so we only keep the push entry.
    for line in output.stdout_str().lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };

        let rest = rest.trim_end();
        let (url, kind) = match rest.rsplit_once(" (") {
            Some((url, kind)) => (url, kind.trim_end_matches(')')),
            None => (rest, ""),
        };

        if kind != "push" {
            continue;
        }

        remotes.push(Remote {
            name: name.to_string(),
            url: url.to_string(),
        });
    }

    Ok(remotes)
}

/// Adds a remote.
pub async fn add_remote(runner: &GitRunner, path: &str, name: &str, url: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "remote".to_string(),
                "add".to_string(),
                name.to_string(),
                url.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Removes a remote.
pub async fn remove_remote(runner: &GitRunner, path: &str, name: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "remote".to_string(),
                "rm".to_string(),
                name.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Changes the URL of a remote.
pub async fn set_url(runner: &GitRunner, path: &str, name: &str, url: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "remote".to_string(),
                "set-url".to_string(),
                name.to_string(),
                url.to_string(),
            ],
        )
        .await
        .map(|_| ())
}
