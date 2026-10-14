//! Reviewer-comment handlers: `comment.create`, `comment.list`,
//! `comment.delete` and `comment.send`.
//!
//! Comments are stored **per repository** as JSON under `<data_dir>/comments/`,
//! one file per repo (named from a hash of the repository id, reused from the
//! repository store). The store is read on demand and rewritten on mutation —
//! there is no in-memory cache. `comment.send` hands the comment body plus a
//! window of the referenced file to the shared `comment` agent task (see
//! [`crate::handlers::agents`]) and records the agent's reply.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents::safe_join_repo_file;
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

    // Snapshot the comment before the (possibly multi-minute) agent run: the
    // store is re-read afterwards, so a comment created or deleted meanwhile is
    // not clobbered by a stale copy of the whole list.
    let comment = load_comments(&state.data_dir, &params.path)?
        .into_iter()
        .find(|comment| comment.id == params.id)
        .ok_or_else(|| ApiError::not_found(format!("comment not found: {}", params.id)))?;

    let context =
        build_comment_context(&params.path, &comment.file, comment.line, &comment.body).await?;

    let (reply, agent) = run_task(state, TASK_COMMENT, &context).await?;

    // Re-read the store and touch only this comment; if it was deleted while the
    // agent ran there is nothing left to fill in.
    let mut comments = load_comments(&state.data_dir, &params.path)?;
    let index = comments
        .iter()
        .position(|comment| comment.id == params.id)
        .ok_or_else(|| ApiError::not_found(format!("comment not found: {}", params.id)))?;

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
    // `file` is client input, so it goes through the repository guard: a path
    // that escapes the repo is an error, never a read.
    let full = safe_join_repo_file(repo_path, file)?;

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

    format!("{tail}-{:016x}", fnv1a64(id.as_bytes()))
}

/// FNV-1a 64-bit over `bytes`.
///
/// The standard library's `DefaultHasher` is explicitly *not* stable across Rust
/// releases, so rebuilding the daemon would rename every comments file (and so
/// "lose" every comment). FNV-1a is a fixed algorithm, so the key survives both
/// rebuilds and upgrades.
fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }

    hash
}

/// Reads a repository's comments, returning an empty list when none are stored.
///
/// An unparsable file is *not* fatal: it is quarantined (best effort) and an
/// empty list returned, so a corrupt store degrades to "no comments" instead of
/// bricking every comment operation for that repository.
fn load_comments(data_dir: &Path, path: &str) -> Result<Vec<Comment>, ApiError> {
    let file = comments_path(data_dir, path);

    match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(comments) => Ok(comments),
            Err(error) => {
                crate::log::warn("Failed to parse comments file; quarantining it")
                    .field("path", file.display().to_string())
                    .field("error", error.to_string());
                quarantine_corrupt_file(&file);

                Ok(Vec::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ApiError::from(error)),
    }
}

/// Renames an unparsable comments file aside so it can still be inspected,
/// keeping the original name recognizable. Best effort: a failed rename leaves
/// the file in place, and the caller already recovers with an empty list.
fn quarantine_corrupt_file(file: &Path) {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);

    let mut quarantined = file.to_path_buf().into_os_string();
    quarantined.push(format!(".corrupt-{unix}"));

    if let Err(error) = std::fs::rename(file, PathBuf::from(quarantined)) {
        crate::log::warn("Failed to quarantine corrupt comments file")
            .field("path", file.display().to_string())
            .field("error", error.to_string());
    }
}

/// Writes a repository's comments back to disk (pretty-printed JSON).
///
/// The write goes to a sibling temp file that is then renamed over the target:
/// `rename` is atomic within a directory, so a crash (or a concurrent write) can
/// never leave a half-written store behind for [`load_comments`] to trip over.
fn save_comments(data_dir: &Path, path: &str, comments: &[Comment]) -> Result<(), ApiError> {
    let dir = data_dir.join(COMMENTS_DIR);
    std::fs::create_dir_all(&dir)?;

    let file = comments_path(data_dir, path);
    let text = serde_json::to_string_pretty(comments)?;

    // A sibling temp file (`<file>.tmp`) renamed over the target.
    let mut temp = file.clone().into_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);

    std::fs::write(&temp, text).inspect_err(|_| {
        // Never leave a stray temp file behind on a failed write.
        let _ = std::fs::remove_file(&temp);
    })?;

    if let Err(error) = std::fs::rename(&temp, &file) {
        let _ = std::fs::remove_file(&temp);
        return Err(ApiError::from(error));
    }

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
