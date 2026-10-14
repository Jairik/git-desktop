//! Local AI-agent handlers — the thin JSON-RPC surface over [`crate::agents`].
//!
//! These handlers build the per-call context (a diff / file / commit / PR) and
//! hand it to the shared [`run_task`] orchestration, which:
//!
//! 1. loads the effective [`AgentsConfig`];
//! 2. resolves the task → its [`TaskConfig`] → its enabled [`AgentSpec`]
//!    (`not_found` when either is missing — see the contract);
//! 3. checks the agent is installed via the cached `agent.list` scan
//!    (`auth_required` when its binary is missing);
//! 4. injects the task's skill (if any), builds one prompt and runs the agent
//!    (a non-zero exit / timeout → [`ApiError::agent_error`] with `data.stderr`).
//!
//! Adding a method here is a matter of adding one handler that builds a context
//! string and registers its name in the dispatch table in [`crate::rpc`]. A new
//! *task* only needs a `[tasks.<name>]` table in `server/agents.toml` (no code).

use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents;
use crate::error::ApiError;
use crate::git::reject_option;
use crate::github::GhOptions;
use crate::handlers::github::{require_auth, require_repo};
use crate::models::{
    AgentReview, AgentsConfig, CommitMessageResult, DetectedAgent, ReviewTarget, SummarizeResult,
};
use crate::rpc::params_of;
use crate::state::AppState;

/// The `commit_message` task key in the agents config.
const TASK_COMMIT_MESSAGE: &str = "commit_message";
/// The `summarize_file` task key.
const TASK_SUMMARIZE_FILE: &str = "summarize_file";
/// The `review` task key.
const TASK_REVIEW: &str = "review";
/// The `comment` task key (run by `comment.send`).
pub(crate) const TASK_COMMENT: &str = "comment";

/// Parameters for `agent.commit_message`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageParams {
    /// The absolute path of the repository.
    pub path: String,
    /// Whether to describe the staged changes (default) or the working tree.
    #[serde(default = "default_true")]
    pub staged: bool,
}

/// Parameters for `agent.summarize_file`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeFileParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The file path relative to the repository root.
    pub file: String,
    /// An optional ref to read the file from (`git show <ref>:<file>`); when
    /// omitted the working-tree file is read from disk.
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

/// Parameters for `agent.review`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewParams {
    /// The absolute path of the repository.
    pub path: String,
    /// What to review (a file, a commit or a pull request).
    pub target: ReviewTarget,
}

/// Parameters for `agent.config.set`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetParams {
    /// The config to persist; its `configPath` is ignored (derived on read).
    pub config: AgentsConfig,
}

/// The default for `staged` (true: describe the index, not the working tree).
fn default_true() -> bool {
    true
}

/// `agent.list` — every configured agent with its `PATH` availability.
///
/// The scan runs every configured agent's detect probe once and caches the
/// result in [`crate::state::AppState::agent_cache`] until `agent.config.set`
/// clears it.
pub async fn agent_list(state: &AppState, _params: Value) -> Result<Value, ApiError> {
    let config = agents::load_config(&state.data_dir)?;
    let detected = ensure_scanned(state, &config).await?;

    Ok(json!({ "agents": detected }))
}

/// `agent.config.get` — the effective config plus the path `config.set` writes to.
pub async fn agent_config_get(state: &AppState, _params: Value) -> Result<Value, ApiError> {
    let config = agents::load_config(&state.data_dir)?;

    Ok(json!(config))
}

/// `agent.config.set` — persist the config under the data dir and clear the
/// agent-detection cache.
pub async fn agent_config_set(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ConfigSetParams = params_of(params)?;

    agents::write_config(&state.data_dir, &params.config)?;

    // The available agents may have changed; drop the cached scan.
    *state.lock_agent_cache() = None;

    Ok(json!({}))
}

/// `agent.commit_message` — generate a commit message from the staged (default)
/// or working-tree changes.
pub async fn agent_commit_message(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CommitMessageParams = params_of(params)?;

    let base: &[&str] = if params.staged {
        &["diff", "--cached", "--no-color"]
    } else {
        &["diff", "--no-color"]
    };

    let diff = state.runner.run_in(&params.path, base).await?.stdout_str();

    let mut stat_args = base.to_vec();
    stat_args.push("--stat");
    let stat = state.runner.run_in(&params.path, &stat_args).await?.stdout_str();

    let context = format!("Diff stat:\n{stat}\n\nDiff:\n{diff}");

    let (message, agent) = run_task(state, TASK_COMMIT_MESSAGE, &context).await?;

    Ok(json!(CommitMessageResult { message, agent }))
}

/// `agent.summarize_file` — summarize a file's contents.
///
/// With a `ref` the committed blob is read (`git show <ref>:<file>`); otherwise
/// the working-tree file is read from disk (so new/untracked files work too).
pub async fn agent_summarize_file(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: SummarizeFileParams = params_of(params)?;

    let context = match &params.reference {
        Some(reference) => {
            reject_option(reference)?;
            require_nonempty("file", &params.file)?;
            let blob = format!("{reference}:{}", params.file);
            state
                .runner
                .run_in(&params.path, &["show", &blob, "--no-color"])
                .await?
                .stdout_str()
        }
        None => read_working_file(&params.path, &params.file).await?,
    };

    let (summary, agent) = run_task(state, TASK_SUMMARIZE_FILE, &context).await?;

    Ok(json!(SummarizeResult { summary, agent }))
}

/// `agent.review` — review a file's changes, a commit, or a pull request.
///
/// The chosen context builder reuses the existing git/gh helpers; only the
/// pull-request target needs `gh` to be installed and authenticated.
pub async fn agent_review(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ReviewParams = params_of(params)?;
    let path = params.path.clone();

    let context = match &params.target {
        ReviewTarget::File { file, reference } => {
            require_nonempty("file", file)?;

            match reference {
                // An explicit ref: diff the file's changes against that revision.
                Some(rev) => {
                    reject_option(rev)?;
                    state
                        .runner
                        .run_in(&path, &["diff", rev, "--no-color", "--", file])
                        .await
                        .map(|output| output.stdout_str())
                        .unwrap_or_default()
                }
                // No ref: diff the file's uncommitted changes against HEAD. On an
                // unborn HEAD (a brand-new repo with no commits yet) fall back to
                // diffing the index against the empty tree so the staged file is
                // still reviewable. Reviewing is best-effort, so any other git
                // failure yields empty context rather than an error.
                None => {
                    match state
                        .runner
                        .run_in(&path, &["diff", "HEAD", "--no-color", "--", file])
                        .await
                    {
                        Ok(output) => output.stdout_str(),
                        Err(ApiError::GitError { code: 128, .. }) => state
                            .runner
                            .run_in(&path, &["diff", "--cached", "--no-color", "--", file])
                            .await
                            .map(|output| output.stdout_str())
                            .unwrap_or_default(),
                        Err(_) => String::new(),
                    }
                }
            }
        }
        ReviewTarget::Commit { sha } => {
            reject_option(sha)?;
            state
                .runner
                .run_in(&path, &["show", sha, "--no-color"])
                .await?
                .stdout_str()
        }
        ReviewTarget::Pr { number } => {
            require_auth(&state.gh).await?;
            let (owner, repo) = require_repo(state, &path).await?;
            let repo_arg = format!("{owner}/{repo}");

            let view = state
                .gh
                .run_json(GhOptions::in_dir(
                    &path,
                    vec![
                        "pr".to_string(),
                        "view".to_string(),
                        number.to_string(),
                        "--repo".to_string(),
                        repo_arg.clone(),
                        "--json".to_string(),
                        "title,body".to_string(),
                    ],
                ))
                .await?;

            let title = view
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let body = view.get("body").and_then(Value::as_str).unwrap_or_default();

            let diff = state
                .gh
                .run(GhOptions::in_dir(
                    &path,
                    vec![
                        "pr".to_string(),
                        "diff".to_string(),
                        number.to_string(),
                        "--repo".to_string(),
                        repo_arg,
                    ],
                ))
                .await?
                .stdout;

            format!("Pull Request #{number} ({owner}/{repo}): {title}\n\n{body}\n\nDiff:\n{diff}")
        }
    };

    let (output, agent) = run_task(state, TASK_REVIEW, &context).await?;

    Ok(json!(AgentReview {
        agent,
        target: params.target,
        summary: None,
        output,
    }))
}

/// Ensures the agent-detection cache is populated and returns a clone of it.
///
/// The first call (or the first after `agent.config.set`) runs a detect probe
/// for every configured agent; later calls reuse the cached result. The config
/// is passed so we scan exactly the configured agents.
async fn ensure_scanned(
    state: &AppState,
    config: &AgentsConfig,
) -> Result<Vec<DetectedAgent>, ApiError> {
    {
        let cache = state.lock_agent_cache();
        if let Some(cached) = cache.as_ref() {
            return Ok(cached.clone());
        }
    }

    let mut detected = Vec::with_capacity(config.agents.len());
    for spec in &config.agents {
        detected.push(state.agent.detect(spec).await);
    }

    *state.lock_agent_cache() = Some(detected.clone());

    Ok(detected)
}

/// Runs a task end to end: resolve the agent, check availability, inject the
/// skill, build the prompt, run the agent, and map failures per the contract.
///
/// Returns `(trimmed_stdout, agent_name)`. Shared with [`crate::handlers::comments`]
/// for `comment.send`.
pub(crate) async fn run_task(
    state: &AppState,
    task: &str,
    context: &str,
) -> Result<(String, String), ApiError> {
    let config = agents::load_config(&state.data_dir)?;

    let task_config = config
        .tasks
        .get(task)
        .ok_or_else(|| ApiError::not_found(format!("no agent is configured for task '{task}'")))?;

    let spec = config
        .agents
        .iter()
        .find(|agent| agent.name == task_config.agent && agent.enabled)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "agent '{}' configured for task '{task}' is not defined or is disabled",
                task_config.agent
            ))
        })?;

    let detected = ensure_scanned(state, &config).await?;
    let available = detected
        .iter()
        .find(|agent| agent.name == spec.name)
        .map(|agent| agent.available)
        .unwrap_or(false);

    if !available {
        return Err(ApiError::auth_required(format!(
            "the agent '{}' configured for task '{}' is not installed on PATH",
            spec.name, task
        )));
    }

    // Skill injection is best-effort: a missing skill degrades to the prompt
    // alone rather than failing.
    let skill = task_config.skill.as_deref().and_then(agents::resolve_skill);
    let prompt =
        agents::build_prompt(skill.as_deref(), &task_config.prompt, context, agents::byte_budget());

    let output = state.agent.run(spec, prompt, agents::run_timeout()).await?;

    if output.code != 0 {
        return Err(ApiError::agent_error(
            format!("the agent '{}' exited with code {}", spec.name, output.code),
            output.stderr.clone(),
        ));
    }

    Ok((output.stdout.trim().to_string(), spec.name.clone()))
}

/// Reads a working-tree file into a (lossy) UTF-8 string for use as context.
async fn read_working_file(repo_path: &str, file: &str) -> Result<String, ApiError> {
    require_nonempty("file", file)?;

    let full = Path::new(repo_path).join(file);
    let display = full.display().to_string();

    let result = tokio::task::spawn_blocking(move || std::fs::read(&full))
        .await
        .map_err(|error| ApiError::internal(format!("file read task failed: {error}")))?;

    result
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found(format!("working-tree file not found: {display}"))
            } else {
                ApiError::from(error)
            }
        })
}

/// Rejects an empty required parameter (used for file paths, which are passed
/// as git pathspecs after `--` and so don't need the leading-`-` check that
/// [`reject_option`] applies to refs/shas).
fn require_nonempty(field: &str, value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        return Err(ApiError::bad_request(format!("'{field}' must not be empty")));
    }

    Ok(())
}
