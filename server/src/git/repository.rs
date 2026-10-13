//! Repository level commands: detecting the kind of repository at a path and
//! initializing new ones.

use std::path::Path;

use super::GitRunner;
use crate::error::ApiError;
use crate::models::RepositoryType;

/// Determines what kind of repository lives at the given path.
pub async fn repository_type(runner: &GitRunner, path: &str) -> Result<RepositoryType, ApiError> {
    if !Path::new(path).is_dir() {
        return Ok(RepositoryType::Missing);
    }

    let bare = match runner
        .run_in(path, &["rev-parse".to_string(), "--is-bare-repository".to_string()])
        .await
    {
        Ok(output) => output.stdout_str().trim() == "true",
        Err(ApiError::GitError { stderr, .. }) => {
            // A repository we don't own (git's "dubious ownership" check) or a
            // path that isn't a repository at all.
            if stderr.contains("dubious ownership") || stderr.contains("unsafe repository") {
                return Ok(RepositoryType::Unsafe {
                    path: path.to_string(),
                });
            }

            return Ok(RepositoryType::Missing);
        }
        Err(error) => return Err(error),
    };

    let git_dir = git_dir(runner, path).await?;

    if bare {
        return Ok(RepositoryType::Bare { git_dir });
    }

    let top_level = runner
        .run_in(path, &["rev-parse".to_string(), "--show-toplevel".to_string()])
        .await?
        .stdout_str()
        .trim()
        .to_string();

    Ok(RepositoryType::Regular {
        top_level_working_directory: top_level,
        git_dir,
    })
}

/// Runs `git init` in the given path, defaulting the branch to `main`.
pub async fn init_repository(runner: &GitRunner, path: &str) -> Result<(), ApiError> {
    std::fs::create_dir_all(path)?;

    runner
        .run_in_vec(
            path,
            vec![
                "-c".to_string(),
                "init.defaultBranch=main".to_string(),
                "init".to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// The absolute path of the repository's git directory.
pub async fn git_dir(runner: &GitRunner, path: &str) -> Result<String, ApiError> {
    Ok(super::status::git_dir(runner, path)
        .await?
        .to_string_lossy()
        .to_string())
}
