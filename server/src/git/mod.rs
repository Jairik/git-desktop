//! The `git` execution layer.
//!
//! [`GitRunner`] is the single place in the daemon that talks to the `git` CLI.
//! It mirrors the execution model of the legacy TypeScript engine: every call
//! runs `git -C <path> <args>` as a subprocess (on a blocking thread so the
//! async runtime stays responsive), captures stdout/stderr and the exit code,
//! and layers the environment described in the server-client contract.
//!
//! Adding a new git operation to the daemon is a matter of adding a helper
//! function in one of the submodules of this module — there is no other place
//! in the code base that spawns git.

/// Domain modules: one per git workflow area.
pub mod branch;
pub mod commit;
pub mod config;
pub mod diff;
pub mod network;
pub mod remote;
pub mod repository;
pub mod stash;
pub mod status;
pub mod tags;

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use crate::error::ApiError;

/// The marker prefix used to identify stashes created by this desktop client.
pub const DESKTOP_STASH_MARKER: &str = "!!GitHub_Desktop";

/// Options for a single git invocation.
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// The directory to run git in (`git -C <path>`); omitted when `None`.
    pub path: Option<String>,
    /// The arguments passed to git.
    pub args: Vec<String>,
    /// Data written to the process' stdin.
    pub stdin: Option<Vec<u8>>,
    /// Exit codes treated as success; defaults to `0`.
    pub success_codes: Option<Vec<i32>>,
}

impl RunOptions {
    /// Creates options for `git -C <path> <args>`.
    pub fn new<S: AsRef<str>>(path: &str, args: &[S]) -> Self {
        RunOptions {
            path: Some(path.to_string()),
            args: args.iter().map(|a| a.as_ref().to_string()).collect(),
            stdin: None,
            success_codes: None,
        }
    }

    /// Sets the stdin data for the call.
    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    /// Adds extra exit codes which should be treated as success.
    pub fn success_codes(mut self, codes: &[i32]) -> Self {
        self.success_codes = Some(codes.to_vec());
        self
    }

    /// The argv of the invocation, excluding the `git` executable itself.
    pub fn argv(&self) -> Vec<String> {
        let mut argv = Vec::with_capacity(self.args.len() + 2);
        if let Some(path) = &self.path {
            argv.push("-C".to_string());
            argv.push(path.clone());
        }
        argv.extend(self.args.iter().cloned());
        argv
    }
}

/// The raw result of a git invocation.
#[derive(Debug, Clone)]
pub struct GitOutput {
    /// Stdout as captured from the process.
    pub stdout: Vec<u8>,
    /// Stderr as captured from the process.
    pub stderr: String,
    /// The exit code of the process.
    pub code: i32,
}

impl GitOutput {
    /// Stdout decoded as UTF-8 (lossy — git diffs are treated as UTF-8).
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }
}

/// Runs git commands with the environment layering mandated by the contract.
///
/// The runner is stateless and cheap to clone; it lives in
/// [`crate::state::AppState`] so every handler can reach it.
#[derive(Debug, Clone, Copy, Default)]
pub struct GitRunner;

impl GitRunner {
    /// Runs a git command, returning [`ApiError::GitError`] on failure.
    pub async fn run(&self, opts: RunOptions) -> Result<GitOutput, ApiError> {
        let argv = opts.argv();
        let opts_for_blocking = opts.clone();

        let spawned = tokio::task::spawn_blocking(move || run_blocking(opts_for_blocking))
            .await
            .map_err(|error| ApiError::internal(format!("git task failed: {error}")))??;

        let success_codes = opts.success_codes.clone().unwrap_or_else(|| vec![0]);

        if success_codes.contains(&spawned.code) {
            Ok(spawned)
        } else {
            Err(ApiError::GitError {
                stderr: spawned.stderr.clone(),
                args: argv,
                code: spawned.code,
            })
        }
    }

    /// Convenience wrapper: `git -C <path> <args>`.
    pub async fn run_in<S: AsRef<str>>(
        &self,
        path: &str,
        args: &[S],
    ) -> Result<GitOutput, ApiError> {
        self.run(RunOptions::new(path, args)).await
    }

    /// Convenience wrapper accepting a `Vec<String>` of arguments.
    pub async fn run_in_vec(&self, path: &str, args: Vec<String>) -> Result<GitOutput, ApiError> {
        let opts = RunOptions {
            path: Some(path.to_string()),
            args,
            stdin: None,
            success_codes: None,
        };

        self.run(opts).await
    }

    /// Runs `git -C <path> <args>`, treating `success_codes` as success.
    pub async fn run_in_with<S: AsRef<str>>(
        &self,
        path: &str,
        args: &[S],
        success_codes: &[i32],
    ) -> Result<GitOutput, ApiError> {
        self.run(RunOptions::new(path, args).success_codes(success_codes))
            .await
    }

    /// Runs git without a working directory, using `success_codes` as success.
    pub async fn run_global<S: AsRef<str>>(
        &self,
        args: &[S],
        success_codes: Option<&[i32]>,
    ) -> Result<GitOutput, ApiError> {
        let mut opts = RunOptions {
            path: None,
            args: args.iter().map(|a| a.as_ref().to_string()).collect(),
            stdin: None,
            success_codes: None,
        };

        if let Some(codes) = success_codes {
            opts = opts.success_codes(codes);
        }

        self.run(opts).await
    }
}

/// Spawns git synchronously; intended to run inside `spawn_blocking`.
fn run_blocking(opts: RunOptions) -> std::io::Result<GitOutput> {
    let mut command = Command::new("git");

    if let Some(path) = &opts.path {
        command.arg("-C").arg(path);
    }

    command.args(&opts.args);

    // Environment layering — low to high precedence:
    //   TERM=dumb, GIT_TERMINAL_PROMPT=0, GIT_ASKPASS="" (never prompt).
    // Everything else is inherited from the parent process.
    command
        .env("TERM", "dumb")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat");

    if opts.stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }

    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn()?;

    // Stdout and stderr have to be drained concurrently: a git command that
    // writes more than a pipe buffer's worth (~64KB) of output would otherwise
    // block forever against a read that only happens after the other pipe
    // filled up. stderr goes to a thread, stdout is read here.
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut stderr = String::new();
            let _ = pipe.read_to_string(&mut stderr);
            stderr
        })
    });

    // Write (small) stdin and close it FIRST so the child sees EOF. A child
    // that reads stdin before emitting stdout (e.g. `commit -F -` reading the
    // message) would otherwise deadlock: it blocks reading stdin while we block
    // reading stdout to EOF. stdin here is only ever small (commit messages,
    // config values).
    if let Some(stdin) = &opts.stdin {
        if let Some(mut pipe) = child.stdin.take() {
            // A closed pipe (EPIPE) means git exited before consuming the
            // input; that's not interesting since we look at the exit code
            // below anyway.
            let _ = pipe.write_all(stdin);
            let _ = pipe.flush();
        }
    }

    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)?;
    }

    let stderr = match stderr_handle {
        Some(handle) => handle.join().unwrap_or_default(),
        None => String::new(),
    };

    let status = child.wait()?;

    Ok(GitOutput {
        stdout,
        stderr,
        code: status.code().unwrap_or(-1),
    })
}

/// Whether git's stderr for an exit code 128 means the path is not a git
/// repository at all.
///
/// Git also exits 128 for a bare repository, a permission problem or a corrupt
/// object database; those must surface as errors instead of being reported as
/// an empty repository.
pub(crate) fn is_missing_repository(stderr: &str) -> bool {
    let stderr = stderr.to_lowercase();

    stderr.contains("not a git repository") || stderr.contains("dubious ownership")
}

/// Whether git's stderr for an exit code 128 means there is no history to
/// report: an unborn HEAD, or a path that isn't a repository at all.
pub(crate) fn is_empty_history(stderr: &str) -> bool {
    let stderr = stderr.to_lowercase();

    is_missing_repository(&stderr) || stderr.contains("does not have any commits yet")
}

/// Rejects a value git would read as one of its own options.
///
/// argv is handed to git without a shell, but a value like `--upload-pack=…`
/// still becomes an option, so every client supplied ref, name or sha has to
/// be validated (or separated with `--`/`--end-of-options`) before use.
pub fn reject_option(value: &str) -> Result<(), ApiError> {
    if value.is_empty() {
        return Err(ApiError::bad_request("value must not be empty"));
    }

    if value.starts_with('-') {
        return Err(ApiError::bad_request(format!(
            "value must not start with '-': {value}"
        )));
    }

    Ok(())
}

/// Splits NUL-delimited output into non-empty strings.
pub(crate) fn split_nul(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Splits NUL-delimited output into fields, keeping empty ones.
///
/// `git log -z --format=…` terminates every record with NUL, so the final
/// element is always empty. Fields may legitimately be empty (an empty commit
/// body, for instance) which is why the empty fields have to survive.
pub(crate) fn split_nul_fields(output: &str) -> Vec<String> {
    output.split('\0').map(|s| s.to_string()).collect()
}
