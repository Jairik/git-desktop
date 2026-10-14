//! Commit creation, history and commit manipulation.

use super::{
    is_empty_history, reject_option, split_nul, split_nul_fields, GitOutput, GitRunner,
};
use crate::error::ApiError;
use crate::models::{
    ChangedFilesResult, Commit, CommitIdentity, CommitOneLine, FileChange, AppFileStatus,
};

/// The fields of `git log --format=` used to build a [`Commit`], in order.
const LOG_FIELDS: usize = 8;

/// The machine readable log format used for single commit queries.
fn log_format() -> String {
    [
        "%H",                      // sha
        "%h",                      // short sha
        "%s",                      // summary
        "%b",                      // body
        "%an <%ae> %ad",           // author identity
        "%cn <%ce> %cd",           // committer identity
        "%P",                      // parents
        "%D",                      // refs (tags)
    ]
    .join("%x00")
}

/// Options for `commit.create`.
#[derive(Debug, Clone, Default)]
pub struct CreateCommitOptions {
    /// The summary line of the message.
    pub summary: String,
    /// The body of the message.
    pub description: String,
    /// Files to stage before committing; the index is committed when empty.
    pub files: Vec<String>,
    /// Amend the current commit instead of creating a new one.
    pub amend: bool,
    /// Allow creating a commit without any changes.
    pub allow_empty: bool,
}

/// Creates a commit, staging `files` first when provided.
///
/// Returns the SHA of the resulting commit.
pub async fn create_commit(
    runner: &GitRunner,
    path: &str,
    options: &CreateCommitOptions,
) -> Result<String, ApiError> {
    if !options.files.is_empty() {
        runner
            .run_in_vec(
                path,
                {
                    let mut args = vec!["add".to_string(), "--".to_string()];
                    args.extend(options.files.iter().cloned());
                    args
                },
            )
            .await?;
    }

    let mut message = options.summary.trim().to_string();
    let description = options.description.trim();

    if !description.is_empty() {
        message.push_str("\n\n");
        message.push_str(description);
    }

    let mut args = vec!["commit".to_string(), "-F".to_string(), "-".to_string()];

    if options.amend {
        args.push("--amend".to_string());
    }

    if options.allow_empty {
        args.push("--allow-empty".to_string());
    }

    // Never open an editor, and never write the message through a temp file we
    // would have to clean up.
    args.push("--cleanup=strip".to_string());

    runner
        .run(crate::git::RunOptions::new(path, &args).stdin(message.into_bytes()))
        .await?;

    let output = runner
        .run_in(path, &["rev-parse".to_string(), "HEAD".to_string()])
        .await?;

    Ok(output.stdout_str().trim().to_string())
}

/// Reads the commit history of a repository.
pub async fn list_log(
    runner: &GitRunner,
    path: &str,
    revision_range: Option<&str>,
    limit: Option<usize>,
    skip: Option<usize>,
) -> Result<Vec<Commit>, ApiError> {
    let mut args = vec![
        "log".to_string(),
        "--date=raw".to_string(),
        "--no-show-signature".to_string(),
        "--no-color".to_string(),
        "-z".to_string(),
        format!("--format={}", log_format()),
    ];

    if let Some(limit) = limit {
        args.push(format!("--max-count={limit}"));
    }

    if let Some(skip) = skip {
        args.push(format!("--skip={skip}"));
    }

    if let Some(range) = revision_range {
        args.push("--end-of-options".to_string());
        args.push(range.to_string());
    }

    args.push("--".to_string());

    // Exit code 128 means either an unborn HEAD (no history yet) or a path
    // that isn't a repository; both report an empty history. Anything else
    // (bare repo, permissions) is surfaced as an error.
    let output = match runner.run_in_vec(path, args).await {
        Ok(output) => output,
        Err(ApiError::GitError { code: 128, stderr, .. }) if is_empty_history(&stderr) => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(error),
    };

    Ok(parse_log_output(&output.stdout_str()))
}

/// Reads a compact `sha + summary` history for a repository.
pub async fn list_one_line(
    runner: &GitRunner,
    path: &str,
    revision_range: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<CommitOneLine>, ApiError> {
    let mut args = vec![
        "log".to_string(),
        "--no-color".to_string(),
        "-z".to_string(),
        "--format=%H%x00%s".to_string(),
    ];

    if let Some(limit) = limit {
        args.push(format!("--max-count={limit}"));
    }

    if let Some(range) = revision_range {
        args.push("--end-of-options".to_string());
        args.push(range.to_string());
    }

    args.push("--".to_string());

    let output = match runner.run_in_vec(path, args).await {
        Ok(output) => output,
        Err(ApiError::GitError { code: 128, stderr, .. }) if is_empty_history(&stderr) => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(error),
    };

    let tokens = split_nul_fields(&output.stdout_str());
    let mut commits = Vec::new();

    for pair in tokens.chunks(2) {
        if pair.len() == 2 {
            commits.push(CommitOneLine {
                sha: pair[0].clone(),
                summary: pair[1].clone(),
            });
        }
    }

    Ok(commits)
}

/// Reads a single commit by ref, returning `None` when it doesn't exist.
pub async fn get_commit(
    runner: &GitRunner,
    path: &str,
    reference: &str,
) -> Result<Option<Commit>, ApiError> {
    let args = vec![
        "show".to_string(),
        "-s".to_string(),
        "--date=raw".to_string(),
        "--no-show-signature".to_string(),
        format!("--format={}", log_format()),
        "--end-of-options".to_string(),
        reference.to_string(),
    ];

    let output = runner.run_in_with(path, &args, &[0, 128]).await?;

    if output.code == 128 {
        return Ok(None);
    }

    let stdout = output.stdout_str();
    let commits = parse_log_output(&stdout);

    Ok(commits.into_iter().next())
}

/// The files changed by a commit together with the added/deleted line counts.
pub async fn changed_files(
    runner: &GitRunner,
    path: &str,
    sha: &str,
) -> Result<ChangedFilesResult, ApiError> {
    let name_status = run_log_with(runner, path, sha, "--name-status").await?;
    let numstat = run_log_with(runner, path, sha, "--numstat").await?;

    let mut files = Vec::new();
    let mut lines_added = 0;
    let mut lines_deleted = 0;

    for entry in parse_numstat(&numstat.stdout_str()) {
        // Binary files report `-` for both counts.
        if entry.added >= 0 && entry.deleted >= 0 {
            lines_added += entry.added;
            lines_deleted += entry.deleted;
        }
    }

    for entry in parse_name_status(&name_status.stdout_str()) {
        let status = map_commit_status(&entry.status, entry.old_path.as_deref());

        files.push(FileChange {
            id: entry.path.clone(),
            path: entry.path,
            status,
            submodule_status: None,
        });
    }

    Ok(ChangedFilesResult {
        files,
        lines_added,
        lines_deleted,
    })
}

/// Reverts a commit with `git revert --no-edit`.
pub async fn undo_commit(runner: &GitRunner, path: &str, sha: &str) -> Result<(), ApiError> {
    runner
        .run_in(
            path,
            &[
                "revert".to_string(),
                "--no-edit".to_string(),
                sha.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Moves HEAD onto the given commit using the given reset mode.
pub async fn reset_to(runner: &GitRunner, path: &str, sha: &str, mode: &str) -> Result<(), ApiError> {
    reject_option(sha)?;

    let mode = mode.trim();

    if !matches!(mode, "soft" | "mixed" | "hard") {
        return Err(ApiError::bad_request(format!(
            "unsupported reset mode: {mode}"
        )));
    }

    runner
        .run_in(
            path,
            &[
                "reset".to_string(),
                format!("--{mode}"),
                sha.to_string(),
            ],
        )
        .await
        .map(|_| ())
}

/// Runs `git log <sha> -m -1 --first-parent <flag> -z --format=` on a commit.
async fn run_log_with(
    runner: &GitRunner,
    path: &str,
    sha: &str,
    flag: &str,
) -> Result<GitOutput, ApiError> {
    let args = vec![
        "log".to_string(),
        sha.to_string(),
        "-m".to_string(),
        "-1".to_string(),
        "--first-parent".to_string(),
        flag.to_string(),
        "-z".to_string(),
        "--format=".to_string(),
        "--".to_string(),
    ];

    runner
        .run_in_with(path, &args, &[0])
        .await
        .map_err(|error| match error {
            ApiError::GitError { code: 128, .. } => {
                ApiError::not_found(format!("commit not found: {sha}"))
            }
            other => other,
        })
}

/// A single `--name-status -z` record.
struct NameStatusEntry {
    /// The status letter(s) reported by git.
    status: String,
    /// The previous path for renames and copies.
    old_path: Option<String>,
    /// The path of the file.
    path: String,
}

/// A single `--numstat -z` record.
struct NumstatEntry {
    /// Lines added, or -1 for binary files.
    added: i64,
    /// Lines deleted, or -1 for binary files.
    deleted: i64,
}

/// Parses the `-z --name-status` output of a single-commit log.
fn parse_name_status(output: &str) -> Vec<NameStatusEntry> {
    let tokens = split_nul(output);
    let mut entries = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let status = tokens[index].clone();
        index += 1;

        let is_rename_or_copy = status.starts_with('R') || status.starts_with('C');

        if is_rename_or_copy {
            if index + 1 >= tokens.len() {
                break;
            }

            let old_path = tokens[index].clone();
            let path = tokens[index + 1].clone();
            index += 2;

            entries.push(NameStatusEntry {
                status,
                old_path: Some(old_path),
                path,
            });
        } else {
            let Some(path) = tokens.get(index).cloned() else {
                break;
            };
            index += 1;

            entries.push(NameStatusEntry {
                status,
                old_path: None,
                path,
            });
        }
    }

    entries
}

/// Parses the `-z --numstat` output of a single-commit log.
fn parse_numstat(output: &str) -> Vec<NumstatEntry> {
    let tokens = split_nul(output);
    let mut entries = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let token = &tokens[index];
        index += 1;

        let mut fields = token.split('\t');
        let added = fields.next().unwrap_or_default();
        let deleted = fields.next().unwrap_or_default();
        let inline_path = fields.next().unwrap_or_default();

        if inline_path.is_empty() {
            // Renames and copies emit `added\tdeleted` followed by the two
            // paths as separate NUL-delimited records.
            if index + 1 >= tokens.len() {
                break;
            }

            index += 2;
        }

        entries.push(NumstatEntry {
            added: added.parse().unwrap_or(-1),
            deleted: deleted.parse().unwrap_or(-1),
        });
    }

    entries
}

/// Maps a git status letter onto the client's [`AppFileStatus`].
fn map_commit_status(status: &str, old_path: Option<&str>) -> AppFileStatus {
    let status = status.trim();

    match status {
        "M" => AppFileStatus::Modified,
        "A" => AppFileStatus::New,
        "?" => AppFileStatus::Untracked,
        "D" => AppFileStatus::Deleted,
        _ => {
            if status.starts_with('R') {
                AppFileStatus::Renamed {
                    old_path: old_path.unwrap_or_default().to_string(),
                }
            } else if status.starts_with('C') {
                AppFileStatus::Copied {
                    old_path: old_path.unwrap_or_default().to_string(),
                }
            } else {
                AppFileStatus::Modified
            }
        }
    }
}

/// Parses the NUL-delimited output of a `git log`/`git show --format=` call.
fn parse_log_output(output: &str) -> Vec<Commit> {
    // Empty fields (an empty body, for instance) are significant, so the
    // tokens can't be filtered before chunking.
    let tokens = split_nul_fields(output);
    let mut commits = Vec::new();

    for record in tokens.chunks(LOG_FIELDS) {
        if record.len() < LOG_FIELDS {
            continue;
        }

        let author = parse_commit_identity(&record[4]);
        let committer = parse_commit_identity(&record[5]);

        let (Some(author), Some(committer)) = (author, committer) else {
            continue;
        };

        let tags = record[7]
            .split(", ")
            .filter_map(|reference| reference.strip_prefix("tag: "))
            .map(|tag| tag.to_string())
            .collect();

        commits.push(Commit {
            sha: record[0].clone(),
            short_sha: record[1].clone(),
            summary: record[2].clone(),
            body: record[3].clone(),
            author,
            committer,
            parent_shas: record[6]
                .split(' ')
                .filter(|sha| !sha.is_empty())
                .map(|sha| sha.to_string())
                .collect(),
            tags,
        });
    }

    commits
}

/// Parses a git ident string (`Name <email> <unix> <tz>`) into an identity.
pub fn parse_commit_identity(identity: &str) -> Option<CommitIdentity> {
    let identity = identity.trim();

    let open = identity.find('<')?;
    let close = identity.find('>')?;

    if close <= open {
        return None;
    }

    let name = identity[..open].trim().to_string();
    let email = identity[open + 1..close].to_string();

    let rest = identity[close + 1..].trim();
    let mut parts = rest.split_whitespace();

    let unix = parts.next()?.parse::<i64>().ok()?;
    let tz = parts.next().unwrap_or("+0000");

    let tz_offset = parse_timezone_offset(tz)?;

    Some(CommitIdentity {
        name,
        email,
        date: iso8601_from_unix(unix, tz_offset),
        tz_offset,
    })
}

/// Parses a `+HHMM`/`-HHMM` timezone into minutes from UTC.
fn parse_timezone_offset(value: &str) -> Option<i32> {
    let (sign, rest) = match value.chars().next()? {
        '-' => (-1, &value[1..]),
        '+' => (1, &value[1..]),
        _ => (1, value),
    };

    if rest.len() < 4 {
        return None;
    }

    let hours: i32 = rest[..2].parse().ok()?;
    let minutes: i32 = rest[2..4].parse().ok()?;

    Some(sign * (hours * 60 + minutes))
}

/// Formats a unix timestamp plus timezone offset as an ISO-8601 string.
pub fn iso8601_from_unix(unix: i64, tz_offset_minutes: i32) -> String {
    let local = unix + i64::from(tz_offset_minutes) * 60;

    let days = local.div_euclid(86_400);
    let seconds = local.rem_euclid(86_400);

    let (year, month, day) = civil_from_days(days);

    let (hour, minute, second) = (
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60,
    );

    let (sign, offset) = if tz_offset_minutes < 0 {
        ('-', -tz_offset_minutes)
    } else {
        ('+', tz_offset_minutes)
    };

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000{sign}{:02}:{:02}",
        offset / 60,
        offset % 60
    )
}

/// Converts days since the unix epoch into a `(year, month, day)` tuple.
///
/// Howard Hinnant's `civil_from_days` algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };

    (year + i64::from(month <= 2), month as u32, day as u32)
}
