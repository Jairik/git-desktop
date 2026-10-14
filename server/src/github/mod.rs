//! The `gh` execution layer — the GitHub-CLI counterpart to [`crate::git`].
//!
//! [`GhRunner`] is the single place in the daemon that spawns the `gh` binary.
//! Every GitHub method is deliberately **THIN**: rather than implementing an
//! HTTP client for the GitHub REST/GraphQL API, we shell out to `gh` (which
//! carries its own authentication *and* a bundled `jq`/gojq). Each call runs
//! `gh <args>` as a subprocess on a blocking thread, captures stdout/stderr and
//! the exit code under a generous timeout, and layers a non-interactive,
//! no-color environment so the JSON/NDJSON we parse is stable.
//!
//! This module holds the git-repository-independent GitHub logic:
//!
//! - [`GhRunner`] plus its `run`/`run_json`/`run_ndjson` helpers.
//! - the availability/auth probes ([`GhRunner::gh_available`],
//!   [`GhRunner::gh_authenticated`], [`GhRunner::gh_user`]).
//! - [`origin_owner_repo`], which turns a repo's `origin` remote into an
//!   `owner/repo/hostname` triple.
//!
//! The per-method operations live in the [`pr`] and [`ci`] submodules, and the
//! thin JSON-RPC handlers that shape the wire responses live in
//! [`crate::handlers::github`].
//!
//! # Adding a new GitHub method
//!
//! 1. Add a `pub async fn` to [`pr`], [`ci`] (or a new submodule declared here)
//!    that builds [`GhOptions`], runs a `gh` command through [`GhRunner`] and
//!    parses the result into a [`crate::models`] type.
//! 2. Add a thin handler in `crate::handlers::github` that applies the shared
//!    preconditions ([`require_auth`] / `require_repo`-style) and returns the
//!    shaped value.
//! 3. Register the method name in the dispatch table in [`crate::rpc`].
//!
//! There is no other place in the code base that spawns `gh`.
//!
//! [`require_auth`]: crate::handlers::github::require_auth

/// Continuous-integration operations (`ci.status`).
pub mod ci;
/// Pull-request operations (`pr.list`, `pr.view`, `pr.checkout`).
pub mod pr;

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::ApiError;
use crate::git::GitRunner;

/// Hosts treated as GitHub when parsing a remote URL.
///
/// The list is intentionally small; extend it (or read `GH_HOST`) to support
/// GitHub Enterprise installations.
const GITHUB_HOSTS: &[&str] = &["github.com"];

/// The maximum time a `gh` invocation is allowed to run before it is killed.
///
/// `gh api` makes network calls and `gh pr checkout` fetches a PR's commits, so
/// the bound is deliberately generous; it is only a safety net against a hung
/// process (prompts are already disabled via `GH_PROMPT_DISABLED`).
const GH_TIMEOUT: Duration = Duration::from_secs(120);

/// Options for a single `gh` invocation.
#[derive(Debug, Clone)]
pub struct GhOptions {
    /// The working directory to run `gh` in; omitted (the daemon's cwd) when
    /// `None`. Only commands that touch a checkout (`gh pr checkout`) need it.
    pub cwd: Option<String>,
    /// The arguments passed to gh (without the leading `gh`).
    pub args: Vec<String>,
}

impl GhOptions {
    /// Options for `gh <args>` without a specific working directory.
    pub fn new(args: Vec<String>) -> Self {
        GhOptions { cwd: None, args }
    }

    /// Options for `gh <args>` run inside `path` (needs a checked-out repo).
    pub fn in_dir(path: impl Into<String>, args: Vec<String>) -> Self {
        GhOptions {
            cwd: Some(path.into()),
            args,
        }
    }
}

/// The raw result of a `gh` invocation.
#[derive(Debug, Clone)]
pub struct GhOutput {
    /// Stdout as captured from the process (gh always emits UTF-8 text).
    pub stdout: String,
    /// Stderr as captured from the process.
    pub stderr: String,
    /// The exit code of the process.
    pub code: i32,
}

/// Runs `gh` commands with the non-interactive, no-color environment the
/// GitHub methods rely on.
///
/// The runner is stateless and cheap to clone; it lives in
/// [`crate::state::AppState`] so every handler can reach it, exactly like the
/// `git` runner.
#[derive(Debug, Clone, Copy, Default)]
pub struct GhRunner;

impl GhRunner {
    /// Runs a `gh` command, mapping:
    ///
    /// - a missing `gh` binary → [`ApiError::auth_required`];
    /// - a timeout → a [`ApiError::gh_error`] describing the timeout;
    /// - any other non-zero exit → [`ApiError::gh_error`] carrying `stderr`.
    pub async fn run(&self, opts: GhOptions) -> Result<GhOutput, ApiError> {
        let argv = opts.args.clone();

        let spawned = tokio::task::spawn_blocking(move || run_gh_blocking(opts))
            .await
            .map_err(|error| ApiError::internal(format!("gh task failed: {error}")))?;

        let output = match spawned {
            Ok(output) => output,
            Err(error) => match error.kind() {
                // `Command::spawn` fails with NotFound when gh isn't on PATH.
                std::io::ErrorKind::NotFound => {
                    return Err(ApiError::auth_required("the gh CLI is not installed"));
                }
                std::io::ErrorKind::TimedOut => {
                    return Err(ApiError::gh_error(
                        "gh command timed out",
                        argv,
                        -1,
                    ));
                }
                _ => return Err(ApiError::internal(format!("failed to run gh: {error}"))),
            },
        };

        if output.code == 0 {
            Ok(output)
        } else {
            Err(ApiError::gh_error(output.stderr.clone(), argv, output.code))
        }
    }

    /// Runs a `gh` command expected to emit a single JSON document on stdout
    /// (e.g. `gh pr list --json …`), and parses it.
    pub async fn run_json(&self, opts: GhOptions) -> Result<Value, ApiError> {
        let output = self.run(opts).await?;
        serde_json::from_str(output.stdout.trim())
            .map_err(|error| ApiError::internal(format!("failed to parse gh JSON output: {error}")))
    }

    /// Runs a `gh` command emitting NDJSON (`gh api … --jq '.x[] | {…}'` prints
    /// one compact JSON object per line) and parses each non-blank line.
    pub async fn run_ndjson(&self, opts: GhOptions) -> Result<Vec<Value>, ApiError> {
        let output = self.run(opts).await?;
        Ok(parse_ndjson(&output.stdout))
    }

    /// Whether the `gh` CLI is installed (`gh --version` exits 0).
    pub async fn gh_available(&self) -> bool {
        self.run(GhOptions::new(vec!["--version".to_string()]))
            .await
            .is_ok()
    }

    /// Whether `gh` is authenticated (`gh auth token` exits 0).
    ///
    /// This reads local credentials only — it never touches the network.
    pub async fn gh_authenticated(&self) -> bool {
        self.run(GhOptions::new(vec!["auth".to_string(), "token".to_string()]))
            .await
            .is_ok()
    }

    /// The authenticated GitHub login, resolved best-effort via
    /// `gh api user --jq .login`. Returns `None` if gh is unauthenticated or the
    /// lookup fails for any other reason.
    pub async fn gh_user(&self) -> Option<String> {
        let output = self
            .run(GhOptions::new(vec![
                "api".to_string(),
                "user".to_string(),
                "--jq".to_string(),
                ".login".to_string(),
            ]))
            .await
            .ok()?;

        let login = output.stdout.trim().to_string();
        if login.is_empty() {
            None
        } else {
            Some(login)
        }
    }
}

/// Spawns `gh` synchronously; intended to run inside `spawn_blocking`.
///
/// stdout/stderr are drained on separate threads and the child is waited for
/// with a poll loop so a hung process can be killed at [`GH_TIMEOUT`] instead
/// of blocking a worker thread forever.
fn run_gh_blocking(opts: GhOptions) -> std::io::Result<GhOutput> {
    let mut command = Command::new("gh");

    if let Some(path) = &opts.cwd {
        command.current_dir(path);
    }

    command.args(&opts.args);

    // Environment layering — never prompt, never page, never colorize, and
    // never block on an update check.
    command
        .env("GH_PAGER", "cat")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");

    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    // Fails with NotFound here when gh isn't installed; mapped by the caller.
    let mut child = command.spawn()?;

    let stdout_handle = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let stderr_handle = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let deadline = Instant::now() + GH_TIMEOUT;

    loop {
        match child.try_wait()? {
            Some(status) => {
                let stdout = join(stdout_handle);
                let stderr = join(stderr_handle);

                return Ok(GhOutput {
                    stdout,
                    stderr,
                    code: status.code().unwrap_or(-1),
                });
            }
            None => {
                if Instant::now() >= deadline {
                    // Kill the child (closing its pipes wakes the reader
                    // threads), reap it, and report the timeout.
                    let _ = child.kill();
                    let _ = child.wait();
                    join(stdout_handle);
                    join(stderr_handle);

                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "gh command timed out",
                    ));
                }

                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Joins a reader thread, tolerating a panic (yielding the empty string).
fn join(handle: Option<std::thread::JoinHandle<String>>) -> String {
    handle
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default()
}

/// Parses NDJSON output into JSON values.
///
/// Tolerates a trailing newline and skips blank lines; a line that fails to
/// parse as JSON is skipped rather than aborting the whole batch.
pub(crate) fn parse_ndjson(output: &str) -> Vec<Value> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Resolves a repository's origin into an `(owner, repo, hostname)` triple.
///
/// Uses `origin` when present, otherwise the first configured remote. Returns:
///
/// - `Ok(Some((owner, repo, hostname)))` when a GitHub remote was parsed;
/// - `Ok(None)` when a remote URL exists but is **not** a GitHub remote;
/// - `Err(not_found)` when no remote URL could be resolved at all.
pub async fn origin_owner_repo(
    git: &GitRunner,
    path: &str,
) -> Result<Option<(String, String, String)>, ApiError> {
    match resolve_remote_url(git, path).await {
        Some(url) => Ok(parse_github_remote(&url)),
        None => Err(ApiError::not_found(
            "repository has no git remote to derive a GitHub repository from",
        )),
    }
}

/// The origin remote's URL, or the first remote's URL when there is no origin.
///
/// Returns `None` when no remote URL could be resolved (no remotes at all, or a
/// git failure). Git errors are intentionally swallowed: from the caller's
/// point of view an unreachable remote and a missing remote are both "no GitHub
/// remote here".
async fn resolve_remote_url(git: &GitRunner, path: &str) -> Option<String> {
    if let Ok(output) = git.run_in(path, &["remote", "get-url", "origin"]).await {
        let url = output.stdout_str().trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }

    // No (usable) origin: fall back to the first configured remote.
    let remotes = git.run_in(path, &["remote"]).await.ok()?;
    let first = remotes
        .stdout_str()
        .lines()
        .map(str::trim)
        .find(|name| !name.is_empty())?
        .to_string();

    let output = git.run_in(path, &["remote", "get-url", &first]).await.ok()?;
    let url = output.stdout_str().trim().to_string();

    (!url.is_empty()).then_some(url)
}

/// Parses a git remote URL into `(owner, repo, hostname)` when it points at a
/// GitHub host, or `None` otherwise.
///
/// Accepts both SCP-like (`git@github.com:owner/repo.git`) and URL
/// (`https://github.com/owner/repo(.git)`) forms, with an optional `.git`
/// suffix and trailing slashes.
pub(crate) fn parse_github_remote(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();

    let (host, path) = if let Some((_scheme, rest)) = url.split_once("://") {
        // URL form: `scheme://[user@]host[:port]/path`
        let authority_end = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        let path = &rest[authority_end..];
        let host = authority
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or(authority);
        let host = host.split(':').next().unwrap_or(host);
        (host.to_string(), path.to_string())
    } else if let Some((left, right)) = url.split_once(':') {
        // SCP-like form: `[user@]host:path`
        let host = left
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or(left);
        (host.to_string(), right.to_string())
    } else {
        // No scheme and no `host:` separator — a local path.
        return None;
    };

    if !is_github_host(&host) {
        return None;
    }

    // `path` looks like `/owner/repo.git` (URL) or `owner/repo.git` (SCP),
    // possibly with a trailing slash or a `.git` suffix.
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);

    let mut parts = path.split('/').filter(|segment| !segment.is_empty());
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();

    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some((owner, repo, host))
}

/// Whether `host` is one of the configured GitHub hosts (case-insensitive).
fn is_github_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    GITHUB_HOSTS.iter().any(|candidate| host == *candidate)
}

/// Whether a gh failure means "this pull request does not exist".
///
/// `gh pr view` reports a missing PR as a GraphQL error ("Could not resolve to
/// a PullRequest with the number of …"); [`pr::view`] maps that to `null`.
pub(crate) fn is_pr_not_found(error: &ApiError) -> bool {
    match error {
        ApiError::GhError { stderr, .. } => {
            let stderr = stderr.to_lowercase();
            stderr.contains("could not resolve to a pullrequest")
                || stderr.contains("pull request not found")
                || stderr.contains("no pull request")
        }
        _ => false,
    }
}
