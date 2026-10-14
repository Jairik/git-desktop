//! Network operations: fetch, pull, push and clone.
//!
//! All four operations stream git's stderr while the command runs and turn it
//! into the `*.progress` WebSocket events from the server-client contract. The
//! final result is still returned to the caller.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use super::{reject_option, GitOutput, GitRunner};
use crate::error::ApiError;
use crate::git::RunOptions;
use crate::state::EventBus;

/// Fetches from a single remote, or from all remotes when `remote` is `None`.
pub async fn fetch(
    _runner: &GitRunner,
    path: &str,
    remote: Option<&str>,
    prune_background: bool,
    bus: &EventBus,
) -> Result<(), ApiError> {
    let mut args = vec!["fetch".to_string(), "--progress".to_string()];

    if prune_background {
        args.push("--prune".to_string());
    }

    if let Some(remote) = remote {
        args.push(remote.to_string());
    } else {
        args.push("--all".to_string());
    }

    run_with_progress(Some(path), args, bus, "fetch.progress").await
}

/// Pulls from a remote, merging it into the current branch.
pub async fn pull(
    _runner: &GitRunner,
    path: &str,
    remote: Option<&str>,
    bus: &EventBus,
) -> Result<(), ApiError> {
    let mut args = vec!["pull".to_string(), "--progress".to_string()];

    if let Some(remote) = remote {
        args.push(remote.to_string());
    }

    run_with_progress(Some(path), args, bus, "pull.progress").await
}

/// Pushes a local branch to a remote.
pub async fn push(
    _runner: &GitRunner,
    path: &str,
    remote: &str,
    local_branch: &str,
    remote_branch: Option<&str>,
    tags_to_push: &[String],
    force_with_lease: bool,
    bus: &EventBus,
) -> Result<(), ApiError> {
    let mut args = vec!["push".to_string(), "--progress".to_string()];

    if force_with_lease {
        args.push("--force-with-lease".to_string());
    }

    args.push("--".to_string());
    args.push(remote.to_string());

    // A branch name starting with `+` (or `-`) is read by git as a force
    // refspec / an option, so validate both ends before building the refspec.
    reject_option(local_branch)?;

    let refspec = match remote_branch {
        Some(remote_branch) => {
            reject_option(remote_branch)?;
            format!("{local_branch}:{remote_branch}")
        }
        None => local_branch.to_string(),
    };

    args.push(refspec);
    args.extend(tags_to_push.iter().cloned());

    run_with_progress(Some(path), args, bus, "push.progress").await
}

/// Clones a repository into `path`.
pub async fn clone(
    runner: &GitRunner,
    url: &str,
    path: &str,
    branch: Option<&str>,
    default_branch: Option<&str>,
    bus: &EventBus,
) -> Result<(), ApiError> {
    let mut args = vec!["clone".to_string(), "--progress".to_string()];

    // Options come first: everything after `--` is a positional argument, so
    // this is what keeps a url or a path that starts with `-` from being read
    // as an option.
    if let Some(branch) = branch {
        args.push("--branch".to_string());
        args.push(branch.to_string());
    }

    args.push("--".to_string());
    args.push(url.to_string());
    args.push(path.to_string());

    run_with_progress(None, args, bus, "clone.progress").await?;

    // Cloning an empty repository leaves HEAD unborn with whatever name git
    // guessed; point it at the requested default branch instead.
    if let Some(default_branch) = default_branch {
        let head_exists = runner
            .run_in(path, &["rev-parse".to_string(), "--verify".to_string(), "HEAD".to_string()])
            .await
            .is_ok();

        if !head_exists {
            let _ = runner
                .run_in(
                    path,
                    &[
                        "symbolic-ref".to_string(),
                        "HEAD".to_string(),
                        format!("refs/heads/{default_branch}"),
                    ],
                )
                .await;
        }
    }

    Ok(())
}

/// Runs a network operation, translating git's stderr into progress events.
///
/// Unlike [`GitRunner::run`] this reads stderr incrementally so the client sees
/// progress while the command is still running.
async fn run_with_progress(
    path: Option<&str>,
    args: Vec<String>,
    bus: &EventBus,
    event: &str,
) -> Result<(), ApiError> {
    let opts = RunOptions {
        path: path.map(|path| path.to_string()),
        args: args.clone(),
        stdin: None,
        success_codes: Some(vec![0]),
    };

    // The argv is needed after the move into the blocking task, so remember it.
    let argv = opts.argv();

    let blocking_bus = bus.clone();
    let blocking_event = event.to_string();

    let spawned = tokio::task::spawn_blocking(move || {
        run_streaming(opts, &blocking_bus, &blocking_event)
    })
    .await
    .map_err(|error| ApiError::internal(format!("git task failed: {error}")))??;

    if spawned.code != 0 {
        bus.emit(
            event,
            json!({ "phase": "failed", "value": 100, "detail": spawned.stderr.trim() }),
        );

        // A failing pull/merge is a state conflict rather than an unknown git
        // failure; the client uses this to offer conflict resolution.
        if is_merge_conflict(&spawned.stderr) {
            let message = spawned.stderr.trim().to_string();

            return Err(ApiError::Conflict { message });
        }

        return Err(ApiError::GitError {
            stderr: spawned.stderr,
            args: argv,
            code: spawned.code,
        });
    }

    bus.emit(event, json!({ "phase": "completed", "value": 100 }));

    Ok(())
}

/// The blocking half of [`run_with_progress`].
fn run_streaming(opts: RunOptions, bus: &EventBus, event: &str) -> std::io::Result<GitOutput> {
    let mut command = Command::new("git");

    if let Some(path) = &opts.path {
        command.arg("-C").arg(path);
    }

    command.args(&opts.args);

    command
        .env("TERM", "dumb")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never credential prompt; the daemon has no way to answer.
        .env("GIT_ASKPASS", "")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn()?;

    // Drain stdout on a separate thread so the process can never block on a
    // full pipe while we're reading stderr.
    let stdout_handle = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stdout.read_to_end(&mut buffer);
            buffer
        })
    });

    let mut stderr = String::new();

    if let Some(pipe) = child.stderr.take() {
        for line in BufReader::new(pipe).lines() {
            let line = line?;
            stderr.push_str(&line);
            stderr.push('\n');

            if let Some(progress) = progress_from_line(&line) {
                bus.emit(event, progress);
            }
        }
    }

    let stdout = match stdout_handle {
        Some(handle) => handle.join().unwrap_or_default(),
        None => Vec::new(),
    };

    let status = child.wait()?;

    Ok(super::GitOutput {
        stdout,
        stderr,
        code: status.code().unwrap_or(-1),
    })
}

/// Translates one line of git's stderr into a progress event, if we know how.
fn progress_from_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return None;
    }

    // Strip the `remote: ` prefix git adds for progress coming from the server
    // side, and the `error:`/`warning:` prefixes.
    let normalized = trimmed
        .strip_prefix("remote: ")
        .unwrap_or(trimmed)
        .trim();

    let phase = if normalized.starts_with("Cloning into") {
        "cloning"
    } else if normalized.starts_with("Enumerating objects") {
        "enumerating"
    } else if normalized.starts_with("Counting objects") {
        "counting"
    } else if normalized.starts_with("Compressing objects") {
        "compressing"
    } else if normalized.starts_with("Receiving objects") || normalized.starts_with("Writing objects")
    {
        "receiving"
    } else if normalized.starts_with("Resolving deltas") {
        "resolving"
    } else if normalized.starts_with("Updating files")
        || normalized.starts_with("Checking out files")
        || normalized.starts_with("Updating index")
        || normalized.starts_with("Checking out")
    {
        "checkout"
    } else if normalized.starts_with("Downloading") {
        "downloading"
    } else if normalized.starts_with("Unpacking objects") {
        "unpacking"
    } else if normalized.starts_with("From ") || normalized.starts_with("To ") {
        "negotiating"
    } else {
        return None;
    };

    Some(json!({
        "phase": phase,
        "value": percentage(normalized),
        "detail": trimmed,
    }))
}

/// Whether git's stderr reports an unresolved merge conflict.
fn is_merge_conflict(stderr: &str) -> bool {
    stderr.contains("Automatic merge failed")
        || stderr.contains("Merge conflict")
        || stderr.contains("CONFLICT (")
        || stderr.contains("fix conflicts and then commit the result")
        || stderr.contains("You have unmerged paths")
}

/// Extracts a trailing `NN%` from a progress line.
///
/// Git emits several `\r`-separated updates per line, so the last percentage is
/// the most recent one.
fn percentage(line: &str) -> u32 {
    line.split_whitespace()
        .filter_map(|token| token.strip_suffix('%').or_else(|| token.strip_suffix("%,")))
        .filter_map(|value| value.parse().ok())
        .next_back()
        .unwrap_or(0)
}
