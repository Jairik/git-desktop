//! The local AI-agent execution layer — the agent-CLI counterpart to
//! [`crate::git`] and [`crate::github`].
//!
//! [`AgentRunner`] is the single place in the daemon that spawns an AI-agent
//! binary. Like the git/gh runners it shells out (nothing is bundled or
//! downloaded) and runs every child process on a blocking thread so the async
//! runtime stays responsive.
//!
//! An **agent** is an executable on `PATH` (`opencode`, `claude`, `codex`,
//! `cursor-agent`, …). A **task** is a unit of work (`commit_message`,
//! `summarize_file`, `review`, `comment`) that names an agent, an optional
//! **skill** (`<name>/SKILL.md` text injected ahead of the prompt) and a
//! **prompt**. The task's context (a diff / file / commit / comment) is
//! appended to the prompt and handed to the agent as a **single argv argument**
//! — never through a shell — so there is no injection surface and no tool or
//! file-read permission prompt to answer.
//!
//! This module owns:
//!
//! - [`AgentRunner`] plus its [`AgentRunner::detect`]/[`AgentRunner::run`]
//!   helpers (spawn, capture stdout+stderr+exit, enforce a timeout).
//! - the small `PATH` resolver (`resolve_executable`) used to report a binary's
//!   location for [`crate::models::DetectedAgent`].
//! - the repo-file guard ([`safe_join_repo_file`]) every handler that reads a
//!   client-supplied file path applies before touching the filesystem.
//! - the **config**: [`RawAgentsConfig`] (the on-disk TOML shape) plus a
//!   conversion to/from the camelCase [`crate::models::AgentsConfig`] wire shape
//!   and the read/persist resolution in [`load_config`]/[`write_config`].
//! - **skill injection** ([`resolve_skill`]) and **prompt assembly**
//!   ([`build_prompt`]) with the context byte budget.
//!
//! The JSON-RPC handlers that shape the wire responses and apply the
//! availability/not-found error mapping live in [`crate::handlers::agents`].
//!
//! # Adding a new agent or task
//!
//! Edit `server/agents.toml` (the built-in default, embedded below via
//! `include_str!` so it can never drift): add an `[[agents]]` table and/or a
//! `[tasks.<name>]` table. A running daemon picks it up after
//! `agent.config.set` (which also clears the detection cache); there is no Rust
//! code to change. Adding a **new kind of task** (a new context builder, e.g.
//! "explain a stash") only means adding a handler in `handlers::agents` that
//! builds a context string and calls the shared run helper.
//!
//! [`require_auth`]: crate::handlers::github::require_auth

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::models::{AgentSpec, AgentsConfig, DetectedAgent, TaskConfig};

/// The built-in default agents configuration.
///
/// It is `include_str!`-ed from `server/agents.toml`, so the version-controlled
/// documented default and the compiled-in fallback can never diverge.
pub const DEFAULT_CONFIG: &str = include_str!("../../agents.toml");

/// Default maximum per-task run time in seconds (`GITDAEMON_AGENT_TIMEOUT_SECS`).
const DEFAULT_TIMEOUT_SECS: u64 = 240;

/// Default maximum time a detection probe may take, in seconds.
///
/// Version banners are normally instant, but an agent's first run may check for
/// updates; this is only a safety net against a hung process.
const DETECT_TIMEOUT_SECS: u64 = 20;

/// Default maximum number of context bytes appended to a prompt
/// (`GITDAEMON_AGENT_MAX_CONTEXT_BYTES`).
const DEFAULT_CONTEXT_BYTE_BUDGET: usize = 40_000;

/// The env var holding a read-only config override path.
const CONFIG_OVERRIDE_ENV: &str = "GITDAEMON_AGENTS_CONFIG";

/// The env var holding an extra skills search directory.
const SKILLS_DIR_ENV: &str = "GITDAEMON_SKILLS_DIR";

/// The env var overriding the per-task run timeout (seconds).
const TIMEOUT_ENV: &str = "GITDAEMON_AGENT_TIMEOUT_SECS";

/// The env var overriding the context byte budget.
const BUDGET_ENV: &str = "GITDAEMON_AGENT_MAX_CONTEXT_BYTES";

/// The raw stdout/stderr/exit of spawning an agent binary.
///
/// Unlike the git/gh runners this is returned even for a non-zero exit code;
/// interpreting the exit (mapping it into [`ApiError::agent_error`]) is the
/// caller's job, because detection treats a non-zero exit as "not available"
/// while a task run treats it as a failure.
#[derive(Debug, Clone)]
pub struct AgentOutput {
    /// Stdout as captured from the process (treated as UTF-8).
    pub stdout: String,
    /// Stderr as captured from the process.
    pub stderr: String,
    /// The process' exit code (or -1 when killed by a signal).
    pub code: i32,
}

/// Runs AI-agent binaries with the layered environment the tasks rely on.
///
/// The runner is stateless and cheap to clone; it lives in
/// [`crate::state::AppState`] so every handler can reach it, exactly like the
/// git and gh runners.
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentRunner;

impl AgentRunner {
    /// Probes whether `spec`'s binary is installed by running
    /// `<command> <detect...>`. On a zero exit the agent is `available` and the
    /// first non-empty stdout line is captured as its `version`.
    ///
    /// Never fails: a missing binary or a non-zero probe simply yields
    /// `available: false`. The binary's `PATH` location is resolved separately
    /// (a lookup, not an execution), so it is populated even when the probe
    /// fails.
    pub async fn detect(&self, spec: &AgentSpec) -> DetectedAgent {
        let path = resolve_executable(&spec.command);
        let command = spec.command.clone();
        let detect = detect_argv(spec);

        let spawned = tokio::task::spawn_blocking(move || {
            run_agent_blocking(
                command,
                detect,
                None,
                String::new(),
                Duration::from_secs(DETECT_TIMEOUT_SECS),
            )
        })
        .await;

        let (available, version) = match spawned {
            Ok(Ok(output)) if output.code == 0 => (true, first_line(&output.stdout)),
            _ => (false, None),
        };

        DetectedAgent {
            name: spec.name.clone(),
            command: spec.command.clone(),
            path,
            available,
            version,
        }
    }

    /// Runs the agent with `prompt` as the final single argv element
    /// (`<command> <argv...> <prompt>`), capturing output under `timeout`.
    ///
    /// Returns the raw [`AgentOutput`] for *any* exit code; the caller turns a
    /// non-zero exit into [`ApiError::agent_error`]. A missing binary maps to
    /// [`ApiError::auth_required`] and a timeout maps to
    /// [`ApiError::agent_error`] describing the timeout.
    pub async fn run(
        &self,
        spec: &AgentSpec,
        prompt: String,
        timeout: Duration,
    ) -> Result<AgentOutput, ApiError> {
        let command = spec.command.clone();
        let argv = spec.argv.clone();
        let env = spec.env.clone();

        let spawned = tokio::task::spawn_blocking(move || {
            run_agent_blocking(command, argv, env, prompt, timeout)
        })
        .await
        .map_err(|error| ApiError::internal(format!("agent task failed: {error}")))?;

        spawned.map_err(|error| match error.kind() {
            // `Command::spawn` fails with NotFound when the binary isn't on PATH.
            std::io::ErrorKind::NotFound => ApiError::auth_required(format!(
                "the agent binary '{}' is not installed",
                spec.command
            )),
            std::io::ErrorKind::TimedOut => ApiError::agent_error("the agent timed out", ""),
            _ => ApiError::internal(format!("failed to run agent: {error}")),
        })
    }
}

// ---------------------------------------------------------------------------
// Low-level subprocess spawn (runs inside `spawn_blocking`)
// ---------------------------------------------------------------------------

/// The probe argv used to detect whether an agent is installed.
///
/// A spec with no `detect` argv would run the bare command, which for an
/// interactive agent means launching its TUI from a probe; every agent we know
/// answers `--version` instantly and non-interactively, so that is the default.
fn detect_argv(spec: &AgentSpec) -> Vec<String> {
    if spec.detect.is_empty() {
        vec!["--version".to_string()]
    } else {
        spec.detect.clone()
    }
}

/// Spawns an agent synchronously; intended to run inside [`AgentRunner`]'s
/// `spawn_blocking`.
///
/// stdout/stderr are drained on separate threads and the child is waited for
/// with a poll loop so a hung process can be killed at `timeout` instead of
/// blocking a worker thread forever. The prompt is passed as one argv element
/// (no shell), so its contents are never interpreted.
fn run_agent_blocking(
    command: String,
    argv: Vec<String>,
    env: Option<BTreeMap<String, String>>,
    prompt: String,
    timeout: Duration,
) -> std::io::Result<AgentOutput> {
    let mut child_command = Command::new(&command);
    child_command.args(&argv);
    // The prompt is appended as the final single argument when present. The
    // detection probe passes an empty prompt, so it is skipped there (we do not
    // want `opencode --version ""`).
    if !prompt.is_empty() {
        child_command.arg(&prompt);
    }

    // Environment layering, low → high precedence:
    //   inherit the parent env, then the spec's `env`, then NO_COLOR/TERM=dumb
    //   (agents must never colorize or open a pager). The prompt is the final
    //   single argument, so a shell is never involved.
    if let Some(env) = env {
        for (key, value) in env {
            child_command.env(key, value);
        }
    }
    child_command.env("NO_COLOR", "1");
    child_command.env("TERM", "dumb");

    child_command.stdin(Stdio::null());
    child_command.stdout(Stdio::piped());
    child_command.stderr(Stdio::piped());

    // Run the agent in its own process group so a timeout can take down the
    // whole tree. Agents routinely spawn subprocesses that inherit the pipes,
    // and killing only the direct child leaves those grandchildren holding
    // stdout/stderr open — which blocks the reader threads below forever.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        child_command.process_group(0);
    }

    // Fails with NotFound here when the binary isn't installed; mapped by the
    // caller.
    let mut child = child_command.spawn()?;

    let stdout_handle = child.stdout.take().map(|mut pipe| {
        // Draining stdout on its own thread (rather than reading it after the
        // child exits) is what keeps a chatty agent from filling the pipe
        // buffer and deadlocking against us — do not "simplify" this away.
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let stderr_handle = child.stderr.take().map(|mut pipe| {
        // See the stdout reader: stderr is drained concurrently for the same
        // deadlock reason.
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });

    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait()? {
            Some(status) => {
                let stdout = join_reader(stdout_handle);
                let stderr = join_reader(stderr_handle);

                return Ok(AgentOutput {
                    stdout,
                    stderr,
                    code: status.code().unwrap_or(-1),
                });
            }
            None => {
                if Instant::now() >= deadline {
                    // Kill the whole process group (TERM, then KILL) so every
                    // grandchild holding a pipe dies too; only then join the
                    // readers, which EOF once the group is gone. Reaping the
                    // child afterwards keeps it from lingering as a zombie.
                    #[cfg(unix)]
                    let pid = child.id();
                    let _ = child.kill();
                    #[cfg(unix)]
                    kill_process_group(pid);
                    let _ = child.wait();
                    join_reader(stdout_handle);
                    join_reader(stderr_handle);

                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "agent command timed out",
                    ));
                }

                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Signals an agent's whole process group, best effort and without `libc`.
///
/// The child is spawned with `process_group(0)`, so its pid is also its group
/// id: `kill -TERM -<pid>` reaches every descendant. TERM first (a graceful
/// wind-down), then KILL so nothing can outlive the timeout.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    let group = format!("-{pid}");

    let _ = Command::new("kill").arg("-TERM").arg(&group).status();

    // A short grace period for the group to exit on TERM.
    std::thread::sleep(Duration::from_millis(100));

    let _ = Command::new("kill").arg("-KILL").arg(&group).status();
}

/// Joins a reader thread, tolerating a panic (yielding the empty string).
fn join_reader(handle: Option<std::thread::JoinHandle<String>>) -> String {
    handle
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default()
}

/// The first non-empty, trimmed line of an agent's output (its version banner).
fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

/// Resolves a command to an absolute path on `PATH`, or `None` when it isn't
/// found. A command that already contains a path separator is used verbatim.
fn resolve_executable(command: &str) -> Option<String> {
    if command.contains('/') {
        let candidate = Path::new(command);
        return is_executable(candidate).then(|| command.to_string());
    }

    let paths = std::env::var_os("PATH")?;

    std::env::split_paths(&paths).find_map(|dir| {
        let candidate = dir.join(command);
        is_executable(&candidate).then(|| candidate.to_string_lossy().to_string())
    })
}

/// Whether `path` is an executable file. On Unix this checks the executable
/// bit; elsewhere it just checks that a regular file exists.
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/// Loads the `SKILL.md` for a skill `name`, searching the skill directories in
/// order and returning the first readable file's text.
///
/// A skill that isn't found is *not* an error — the caller proceeds with the
/// task prompt alone. The search order is:
///
/// 1. `$GITDAEMON_SKILLS_DIR`, if set;
/// 2. `server/skills` relative to the cwd (running from the repo root);
/// 3. `skills` relative to the cwd (running from `server/`);
/// 4. `../../skills` relative to the binary (a standard `server/target/…` build).
pub fn resolve_skill(name: &str) -> Option<String> {
    for base in skill_search_dirs() {
        let candidate = base.join(name).join("SKILL.md");

        if let Ok(text) = std::fs::read_to_string(&candidate) {
            crate::log::debug("loaded agent skill")
                .field("name", name.to_string())
                .field("path", candidate.display().to_string());
            return Some(text);
        }
    }

    crate::log::debug("agent skill not found; proceeding without it")
        .field("name", name.to_string());

    None
}

/// The base directories to search for `<name>/SKILL.md`, in priority order.
fn skill_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(dir) = std::env::var_os(SKILLS_DIR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        dirs.push(dir);
    }

    dirs.push(PathBuf::from("server/skills"));
    dirs.push(PathBuf::from("skills"));

    // `server/target/<profile>/gitdaemon` → `server/skills`.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("../../skills"));
        }
    }

    dirs
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// Assembles the single prompt string handed to an agent:
/// `[skill text] + task prompt + context`, with the context truncated to
/// `budget` bytes.
///
/// The skill (if any) is doc-style guidance the agent should follow; the task
/// prompt states the concrete job; the context is the diff / file / commit /
/// comment. Oversized context is truncated on a char boundary with a marker so
/// one giant diff can't blow the agent's input limit.
pub fn build_prompt(skill: Option<&str>, task_prompt: &str, context: &str, budget: usize) -> String {
    let mut prompt = String::new();

    if let Some(skill) = skill.map(str::trim).filter(|skill| !skill.is_empty()) {
        prompt.push_str(skill);
        prompt.push_str("\n\n");
    }

    prompt.push_str(task_prompt.trim_end());

    let context = context.trim();
    if !context.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&truncate_bytes(context, budget));
    }

    prompt
}

/// Truncates `text` to at most `budget` bytes on a UTF-8 char boundary,
/// appending a marker when it was cut.
pub fn truncate_bytes(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_string();
    }

    let mut end = budget;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }

    let mut out = String::with_capacity(end + 64);
    out.push_str(&text[..end]);
    out.push_str("\n\n[… context truncated to fit the agent byte budget …]");

    out
}

/// The context byte budget (see [`DEFAULT_CONTEXT_BYTE_BUDGET`]).
pub fn byte_budget() -> usize {
    std::env::var(BUDGET_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|budget| *budget > 0)
        .unwrap_or(DEFAULT_CONTEXT_BYTE_BUDGET)
}

/// The per-task run timeout (see [`DEFAULT_TIMEOUT_SECS`]).
pub fn run_timeout() -> Duration {
    let secs = std::env::var(TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);

    Duration::from_secs(secs)
}

// ---------------------------------------------------------------------------
// Config: raw (TOML) shape, conversion, read and persist resolution
// ---------------------------------------------------------------------------

/// The path `agent.config.set` persists to, relative to the data directory.
const CONFIG_FILE: &str = "agents.toml";

/// The on-disk TOML shape of the config, parsed by [`toml`] and converted to
/// the camelCase [`crate::models::AgentsConfig`] wire shape by [`to_wire`].
///
/// Field names are the snake_case TOML keys (see `server/agents.toml`); the
/// wire shape is a separate type. `toml::from_str` reads it; `toml::to_string`
/// writes it (note the field order — scalars before the `agents`/`env` tables —
/// which TOML requires).
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawAgentsConfig {
    /// The default agent name.
    #[serde(default = "default_agent")]
    default_agent: String,
    /// The agent binaries.
    #[serde(default)]
    agents: Vec<RawAgentSpec>,
    /// The tasks, keyed by task name.
    #[serde(default)]
    tasks: BTreeMap<String, RawTaskConfig>,
}

/// The raw (TOML) agent spec.
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawAgentSpec {
    /// The agent name.
    name: String,
    /// The executable.
    command: String,
    /// The detect probe argv.
    #[serde(default)]
    detect: Vec<String>,
    /// The run argv (prompt appended as the last argument).
    #[serde(default)]
    argv: Vec<String>,
    /// Whether the agent is enabled.
    #[serde(default = "default_enabled")]
    enabled: bool,
    /// Extra environment variables.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<BTreeMap<String, String>>,
}

/// The raw (TOML) task config.
#[derive(Debug, Clone, Deserialize, Serialize)]
struct RawTaskConfig {
    /// The agent name that runs this task.
    agent: String,
    /// The skill name injected ahead of the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill: Option<String>,
    /// The task prompt.
    prompt: String,
}

/// The default `default_agent` when the config omits it.
fn default_agent() -> String {
    "claude".to_string()
}

/// The default for a spec's `enabled` when the config omits it.
fn default_enabled() -> bool {
    true
}

/// The default `configPath` reported on the wire (where `config.set` writes).
fn config_persist_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

/// Loads the effective config, injecting the wire `configPath`.
///
/// Resolution order:
///
/// 1. `$GITDAEMON_AGENTS_CONFIG` (a read-only override path);
/// 2. `<data_dir>/agents.toml` (written by `agent.config.set`);
/// 3. the built-in [`DEFAULT_CONFIG`].
///
/// `configPath` is always reported as `<data_dir>/agents.toml` — the path
/// `agent.config.set` writes to — per the contract.
pub fn load_config(data_dir: &Path) -> Result<AgentsConfig, ApiError> {
    let persist_path = config_persist_path(data_dir);

    let raw = if let Some(override_path) = override_config_path() {
        crate::log::debug("loading agents config from override")
            .field("path", override_path.display().to_string());
        parse_config_file(&override_path)?
    } else if persist_path.is_file() {
        crate::log::debug("loading agents config from data dir")
            .field("path", persist_path.display().to_string());
        parse_config_file(&persist_path)?
    } else {
        parse_toml(DEFAULT_CONFIG)?
    };

    Ok(to_wire(&raw, persist_path.display().to_string()))
}

/// Persists `config` to `<data_dir>/agents.toml` as TOML.
///
/// The wire form is converted back to the raw TOML shape (dropping
/// `configPath`, which is derived on read). When `$GITDAEMON_AGENTS_CONFIG` is
/// set the written file is shadowed by the override on the next read — that's
/// the documented purpose of a read-only override.
pub fn write_config(data_dir: &Path, config: &AgentsConfig) -> Result<(), ApiError> {
    let raw = to_raw(config);
    let text =
        toml::to_string(&raw).map_err(|error| ApiError::internal(format!("failed to serialize agents config: {error}")))?;

    let path = config_persist_path(data_dir);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(&path, text)?;

    crate::log::info("wrote agents config")
        .field("path", path.display().to_string());

    Ok(())
}

/// The read-only config override path from the environment, if set and non-empty.
fn override_config_path() -> Option<PathBuf> {
    std::env::var_os(CONFIG_OVERRIDE_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Reads and parses a config file into the raw shape.
fn parse_config_file(path: &Path) -> Result<RawAgentsConfig, ApiError> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read agents config {}: {error}",
            path.display()
        ))
    })?;

    parse_toml(&text)
}

/// Parses TOML text into the raw shape.
fn parse_toml(text: &str) -> Result<RawAgentsConfig, ApiError> {
    toml::from_str(text)
        .map_err(|error| ApiError::internal(format!("failed to parse agents config: {error}")))
}

/// Converts the raw (TOML) shape into the camelCase wire shape.
fn to_wire(raw: &RawAgentsConfig, config_path: String) -> AgentsConfig {
    AgentsConfig {
        default_agent: raw.default_agent.clone(),
        agents: raw
            .agents
            .iter()
            .map(|agent| AgentSpec {
                name: agent.name.clone(),
                command: agent.command.clone(),
                detect: agent.detect.clone(),
                argv: agent.argv.clone(),
                enabled: agent.enabled,
                env: agent.env.clone(),
            })
            .collect(),
        tasks: raw
            .tasks
            .iter()
            .map(|(name, task)| {
                (
                    name.clone(),
                    TaskConfig {
                        agent: task.agent.clone(),
                        skill: task.skill.clone(),
                        prompt: task.prompt.clone(),
                    },
                )
            })
            .collect(),
        config_path,
    }
}

/// Converts the wire shape back into the raw (TOML) shape for writing.
fn to_raw(config: &AgentsConfig) -> RawAgentsConfig {
    RawAgentsConfig {
        default_agent: config.default_agent.clone(),
        agents: config
            .agents
            .iter()
            .map(|agent| RawAgentSpec {
                name: agent.name.clone(),
                command: agent.command.clone(),
                detect: agent.detect.clone(),
                argv: agent.argv.clone(),
                enabled: agent.enabled,
                env: agent.env.clone(),
            })
            .collect(),
        tasks: config
            .tasks
            .iter()
            .map(|(name, task)| {
                (
                    name.clone(),
                    RawTaskConfig {
                        agent: task.agent.clone(),
                        skill: task.skill.clone(),
                        prompt: task.prompt.clone(),
                    },
                )
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Repository file paths
// ---------------------------------------------------------------------------

/// Resolves the repo-relative `file` against `repo_path`, refusing anything that
/// could escape the repository.
///
/// The `file` parameter is arbitrary client input, so it is validated **before**
/// any read: an empty path, an absolute path (which would silently replace the
/// base in `Path::join`) and any `..` component are rejected outright, and the
/// joined result must canonicalize to a path inside the canonicalized
/// repository — which also rejects symlinks pointing out of the repo.
///
/// When the joined path cannot be canonicalized (a file that isn't there yet)
/// the plain join is returned, so the caller still reports `not_found` rather
/// than a misleading escape error.
pub fn safe_join_repo_file(repo_path: &str, file: &str) -> Result<PathBuf, ApiError> {
    if file.trim().is_empty() {
        return Err(ApiError::bad_request("empty file path"));
    }

    let relative = Path::new(file);

    if relative.is_absolute() {
        return Err(ApiError::bad_request(
            "path escapes repository: absolute paths are not allowed",
        ));
    }

    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApiError::bad_request(
            "path escapes repository: '..' is not allowed",
        ));
    }

    let joined = Path::new(repo_path).join(relative);

    // Canonicalize both sides: the repo itself may not exist yet (or the file may
    // be gone), in which case we keep the lexical join and let the read fail.
    let repo_root =
        std::fs::canonicalize(repo_path).unwrap_or_else(|_| Path::new(repo_path).to_path_buf());

    match std::fs::canonicalize(&joined) {
        Ok(resolved) if resolved.starts_with(&repo_root) => Ok(resolved),
        Ok(_) => Err(ApiError::bad_request("path escapes repository")),
        Err(_) => Ok(joined),
    }
}
