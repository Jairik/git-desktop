//! Reviewer-comment handlers: `comment.create`, `comment.list`,
//! `comment.delete` and `comment.send`.
//!
//! Comments are stored **per repository** as JSON under `<data_dir>/comments/`,
//! one file per repo (named from a hash of the repository id, reused from the
//! repository store). The store is read on demand and rewritten on mutation —
//! there is no in-memory cache. `comment.send` hands the comment body plus a
//! window of the referenced file to the shared `comment` agent task (see
//! [`crate::handlers::agents`]) and records the agent's reply.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::handlers::agents::{run_task, TASK_COMMENT};
use crate::models::{Comment, CommentSide, CommentStatus};
use crate::rpc::params_of;
use crate::state::AppState;
use crate::store;

/// The sub-directory of the data dir comments are persisted to.
const COMMENTS_DIR: &str = "comments";

/// A process-wide counter disambiguating comment ids created in the same
/// nanosecond (comment creation is not a hot path, so a simple counter is fine).
static COMMENT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Parameters for `comment.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentParams {
    /// The absolute path of the repository the file belongs to.
    pub path: String,
    /// The file path relative to the repository root.
    pub file: String,
    /// The line the comment is anchored to, or null for a file-level comment.
    #[serde(default)]
    pub line: Option<u32>,
    /// Which side of the diff the line refers to, or null.
    #[serde(default)]
    pub side: Option<CommentSide>,
    /// The reviewer's comment body (the ask handed to the agent on `send`).
    pub body: String,
}

/// Parameters for `comment.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommentsParams {
    /// The absolute path of the repository.
    pub path: String,
    /// Restrict to comments on this file, or omit for every comment.
    #[serde(default)]
    pub file: Option<String>,
}

/// Parameters for `comment.delete` and `comment.send`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentIdParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The id of the comment to act on.
    pub id: String,
}

/// `comment.create` — record a new open comment on a file/line.
pub async fn comment_create(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CreateCommentParams = params_of(params)?;

    let mut comments = load_comments(&state.data_dir, &params.path)?;

    let comment = Comment {
        id: new_comment_id(),
        file: params.file,
        line: params.line,
        side: params.side,
        body: params.body,
        status: CommentStatus::Open,
        reply: None,
        agent: None,
        created_at: now_iso8601(),
    };

    comments.push(comment.clone());
    save_comments(&state.data_dir, &params.path, &comments)?;

    Ok(json!(comment))
}

/// `comment.list` — every comment in a repo, optionally filtered by file.
pub async fn comment_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ListCommentsParams = params_of(params)?;

    let comments = load_comments(&state.data_dir, &params.path)?;

    let filtered = match &params.file {
        Some(file) => comments
            .into_iter()
            .filter(|comment| &comment.file == file)
            .collect::<Vec<_>>(),
        None => comments,
    };

    Ok(json!(filtered))
}

/// `comment.delete` — remove a comment by id.
pub async fn comment_delete(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CommentIdParams = params_of(params)?;

    let mut comments = load_comments(&state.data_dir, &params.path)?;
    let before = comments.len();
    comments.retain(|comment| comment.id != params.id);

    if comments.len() == before {
        return Err(ApiError::not_found(format!(
            "comment not found: {}",
            params.id
        )));
    }

    save_comments(&state.data_dir, &params.path, &comments)?;

    Ok(json!({}))
}

/// `comment.send` — run the `comment` agent task with the comment as the ask,
/// fill in `reply`/`agent`, and mark the comment `sent`.
pub async fn comment_send(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: CommentIdParams = params_of(params)?;

    let mut comments = load_comments(&state.data_dir, &params.path)?;
    let index = comments
        .iter()
        .position(|comment| comment.id == params.id)
        .ok_or_else(|| ApiError::not_found(format!("comment not found: {}", params.id)))?;

    let comment = comments[index].clone();
    let context =
        build_comment_context(&params.path, &comment.file, comment.line, &comment.body).await?;

    let (reply, agent) = run_task(state, TASK_COMMENT, &context).await?;

    comments[index].reply = Some(reply);
    comments[index].agent = Some(agent);
    comments[index].status = CommentStatus::Sent;
    let updated = comments[index].clone();

    save_comments(&state.data_dir, &params.path, &comments)?;

    Ok(json!(updated))
}

/// Builds the context handed to the `comment` task: the reviewer's comment plus
/// a line-numbered window of the referenced file (the whole file when the
/// comment isn't anchored to a line).
async fn build_comment_context(
    repo_path: &str,
    file: &str,
    line: Option<u32>,
    body: &str,
) -> Result<String, ApiError> {
    let full = Path::new(repo_path).join(file);

    // A file that cannot be read (deleted, non-UTF-8, …) is not fatal: the agent
    // can still answer from the comment body alone.
    let content = tokio::task::spawn_blocking(move || std::fs::read_to_string(&full))
        .await
        .map_err(|error| ApiError::internal(format!("file read task failed: {error}")))?
        .unwrap_or_default();

    let location = match line {
        Some(line) => format!("`{file}`, line {line}"),
        None => format!("`{file}`"),
    };

    Ok(format!(
        "File under review: {file}\n\nThe reviewer left this comment on {location}:\n\n{body}\n\nRelevant file contents (line-numbered; the commented line is marked with '>'):\n{}",
        numbered_lines(&content, line)
    ))
}

/// Renders `content` with line numbers, focused on a ±10-line window around
/// `focus` when given (the whole file otherwise). The focused line is marked.
fn numbered_lines(content: &str, focus: Option<u32>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    if total == 0 {
        return String::new();
    }

    let (from, to) = match focus {
        Some(focus) if focus >= 1 => {
            let focus = focus as usize;
            (focus.saturating_sub(10).max(1), (focus + 10).min(total))
        }
        _ => (1, total),
    };

    (from..=to)
        .map(|line_no| {
            let text = lines.get(line_no - 1).copied().unwrap_or_default();
            let marker = if Some(line_no as u32) == focus { ">" } else { " " };
            format!("{marker} {line_no:>4} | {text}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// The path of the per-repo comments file under `data_dir`.
fn comments_path(data_dir: &Path, path: &str) -> PathBuf {
    data_dir
        .join(COMMENTS_DIR)
        .join(format!("{}.json", repo_comment_key(path)))
}

/// A stable, filesystem-safe key for a repository, derived from the same id the
/// repository store uses (its canonical absolute path) plus a short hash so two
/// repos whose paths sanitize to the same string can never collide.
fn repo_comment_key(path: &str) -> String {
    let id = store::repository_id(path);

    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    let hash = hasher.finish();

    let sanitized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();

    // Keep the tail (the repo's directory name) for readability, then append the
    // hash for uniqueness.
    let count = sanitized.chars().count();
    let tail: String = if count > 48 {
        sanitized.chars().skip(count - 48).collect()
    } else {
        sanitized
    };

    format!("{tail}-{hash:016x}")
}

/// Reads a repository's comments, returning an empty list when none are stored.
fn load_comments(data_dir: &Path, path: &str) -> Result<Vec<Comment>, ApiError> {
    let file = comments_path(data_dir, path);

    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| {
            ApiError::internal(format!(
                "failed to parse comments file {}: {error}",
                file.display()
            ))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ApiError::from(error)),
    }
}

/// Writes a repository's comments back to disk (pretty-printed JSON).
fn save_comments(data_dir: &Path, path: &str, comments: &[Comment]) -> Result<(), ApiError> {
    let dir = data_dir.join(COMMENTS_DIR);
    std::fs::create_dir_all(&dir)?;

    let file = comments_path(data_dir, path);
    let text = serde_json::to_string_pretty(comments)?;
    std::fs::write(&file, text)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Ids and timestamps
// ---------------------------------------------------------------------------

/// Generates a unique comment id from the current time (nanoseconds) and a
/// process-wide counter.
fn new_comment_id() -> String {
    let counter = COMMENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);

    format!("c{nanos:x}-{counter:x}")
}

/// The current time as an ISO-8601 timestamp (UTC), matching the contract.
fn now_iso8601() -> String {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);

    // Reuse the existing RFC-3339/ISO-8601 formatter with a UTC offset.
    crate::git::commit::iso8601_from_unix(unix, 0)
}
