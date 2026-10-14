//! Parsing of `git status --porcelain=2 --branch -z`.
//!
//! Porcelain v2 is the machine readable status format which the legacy engine
//! already used; the entry shapes below mirror `app/src/lib/status-parser.ts`.

use super::{is_missing_repository, split_nul, GitRunner};
use crate::error::ApiError;
use crate::models::{
    AheadBehind, AppFileStatus, FileChange, IStatusResult, SubmoduleStatus, WorkingDirectoryStatus,
};

/// A `# branch.*` header line from porcelain v2.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusHeaders {
    /// The SHA of the tip of the current branch (`branch.oid`).
    pub current_tip: Option<String>,
    /// The name of the current branch (`branch.head`).
    pub current_branch: Option<String>,
    /// The upstream of the current branch (`branch.upstream`).
    pub current_upstream_branch: Option<String>,
    /// How far ahead/behind the branch is (`branch.ab`).
    pub branch_ahead_behind: Option<AheadBehind>,
}

/// A single status entry from porcelain v2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// The two character status code.
    pub status_code: String,
    /// The four character submodule status code.
    pub submodule_status_code: String,
    /// The path of the file relative to the repository root.
    pub path: String,
    /// The path the file was renamed or copied from.
    pub old_path: Option<String>,
}

impl StatusEntry {
    /// The submodule status derived from the submodule status code.
    pub fn submodule_status(&self) -> Option<SubmoduleStatus> {
        let code = &self.submodule_status_code;
        if !code.starts_with('S') {
            return None;
        }

        Some(SubmoduleStatus {
            commit_changed: Some(code.chars().nth(1) == Some('C')),
            modified_changes: Some(code.chars().nth(2) == Some('M')),
            untracked_changes: Some(code.chars().nth(3) == Some('U')),
        })
    }
}

/// The raw parse result: headers first, entries after.
#[derive(Debug, Clone, Default)]
pub struct ParsedStatus {
    /// The branch headers.
    pub headers: StatusHeaders,
    /// The file entries, in the order git reported them.
    pub entries: Vec<StatusEntry>,
}

/// Parses the output of `git status --porcelain=2 --branch -z`.
pub fn parse_status(output: &str) -> ParsedStatus {
    let mut parsed = ParsedStatus::default();
    let tokens = split_nul(output);

    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].clone();
        index += 1;

        if let Some(header) = token.strip_prefix("# ") {
            apply_header(&mut parsed.headers, header);
            continue;
        }

        let kind = token.chars().next().unwrap_or_default();

        match kind {
            '1' => {
                if let Some(entry) = parse_changed_entry(&token) {
                    parsed.entries.push(entry);
                }
            }
            '2' => {
                // For renames and copies git emits the new path followed by
                // the original path, both NUL-terminated.
                let old_path = tokens.get(index).cloned();
                index += 1;

                if let Some(entry) = parse_renamed_or_copied_entry(&token, old_path) {
                    parsed.entries.push(entry);
                }
            }
            'u' => {
                if let Some(entry) = parse_unmerged_entry(&token) {
                    parsed.entries.push(entry);
                }
            }
            '?' => {
                if let Some(entry) = parse_untracked_entry(&token) {
                    parsed.entries.push(entry);
                }
            }
            // Ignored entries (`!`) are not interesting to us.
            '!' => {}
            _ => {}
        }
    }

    parsed
}

/// Handles a single `# branch.*` header line.
fn apply_header(headers: &mut StatusHeaders, value: &str) {
    if let Some(sha) = value.strip_prefix("branch.oid ") {
        if sha.chars().all(|c| c.is_ascii_hexdigit()) && !sha.is_empty() {
            headers.current_tip = Some(sha.to_string());
        }
        return;
    }

    if let Some(head) = value.strip_prefix("branch.head ") {
        if head != "(detached)" {
            headers.current_branch = Some(head.to_string());
        }
        return;
    }

    if let Some(upstream) = value.strip_prefix("branch.upstream ") {
        headers.current_upstream_branch = Some(upstream.to_string());
        return;
    }

    if let Some(ab) = value.strip_prefix("branch.ab ") {
        if let Some(ahead_behind) = parse_ahead_behind(ab) {
            headers.branch_ahead_behind = Some(ahead_behind);
        }
    }
}

/// Parses the `+<ahead> -<behind>` part of `branch.ab`.
fn parse_ahead_behind(value: &str) -> Option<AheadBehind> {
    let mut parts = value.split_whitespace();
    let ahead = parts.next()?;
    let behind = parts.next()?;

    let ahead = ahead.strip_prefix('+')?.parse().ok()?;
    let behind = behind.strip_prefix('-')?.parse().ok()?;

    Some(AheadBehind { ahead, behind })
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
fn parse_changed_entry(field: &str) -> Option<StatusEntry> {
    let mut parts = field.splitn(9, ' ');

    parts.next(); // the record type
    let status_code = parts.next()?.to_string();
    let submodule_status_code = parts.next()?.to_string();

    parts.next(); // mH
    parts.next(); // mI
    parts.next(); // mW
    parts.next(); // hH
    parts.next(); // hI

    // Porcelain v2 in `-z` mode does not quote paths, so the path is the
    // remainder of the record — spaces in the name included.
    let path = parts.next()?.to_string();

    Some(StatusEntry {
        status_code,
        submodule_status_code,
        path,
        old_path: None,
    })
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
fn parse_renamed_or_copied_entry(field: &str, old_path: Option<String>) -> Option<StatusEntry> {
    let mut parts = field.splitn(10, ' ');

    parts.next(); // the record type
    let status_code = parts.next()?.to_string();
    let submodule_status_code = parts.next()?.to_string();

    parts.next(); // mH
    parts.next(); // mI
    parts.next(); // mW
    parts.next(); // hH
    parts.next(); // hI
    parts.next(); // X<score>

    // The new path is the remainder of the record; the old path follows as a
    // separate NUL-delimited record.
    let path = parts.next()?.to_string();

    Some(StatusEntry {
        status_code,
        submodule_status_code,
        path,
        old_path,
    })
}

/// `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn parse_unmerged_entry(field: &str) -> Option<StatusEntry> {
    let mut parts = field.splitn(11, ' ');

    parts.next(); // the record type
    let status_code = parts.next()?.to_string();
    let submodule_status_code = parts.next()?.to_string();

    parts.next(); // m1
    parts.next(); // m2
    parts.next(); // m3
    parts.next(); // mW
    parts.next(); // h1
    parts.next(); // h2
    parts.next(); // h3

    let path = parts.next()?.to_string();

    Some(StatusEntry {
        status_code,
        submodule_status_code,
        path,
        old_path: None,
    })
}

/// `? <path>`
fn parse_untracked_entry(field: &str) -> Option<StatusEntry> {
    let path = field.strip_prefix("? ")?;

    Some(StatusEntry {
        // NOTE: the legacy engine reports `??` for untracked files so that
        // mapStatus can treat it uniformly.
        status_code: "??".to_string(),
        submodule_status_code: "????".to_string(),
        path: path.to_string(),
        old_path: None,
    })
}

/// Maps a porcelain status entry onto the client's [`AppFileStatus`] union.
///
/// Mirrors `mapStatus` in the legacy status parser.
pub fn map_status(entry: &StatusEntry) -> AppFileStatus {
    let code = entry.status_code.as_str();

    match code {
        "??" => return AppFileStatus::Untracked,
        ".M" | "M." => return AppFileStatus::Modified,
        ".A" | "A." | "AM" | "AD" => return AppFileStatus::New,
        ".D" | "D." => return AppFileStatus::Deleted,
        ".R" | "R." | "RM" | "RD" => {
            return AppFileStatus::Renamed {
                old_path: entry
                    .old_path
                    .clone()
                    .unwrap_or_else(|| entry.path.clone()),
            }
        }
        ".C" | "C." => {
            return AppFileStatus::Copied {
                old_path: entry
                    .old_path
                    .clone()
                    .unwrap_or_else(|| entry.path.clone()),
            }
        }
        "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU" => {
            return AppFileStatus::Conflicted {
                conflicted_entry: crate::models::ConflictedEntry::Conflicted,
            }
        }
        _ => {}
    }

    // Fallbacks for two letter codes we don't enumerate: the index state wins.
    let index = code.chars().next().unwrap_or('.');
    let worktree = code.chars().nth(1).unwrap_or('.');

    match (index, worktree) {
        ('.', 'M') | ('M', '.') | ('M', 'M') => AppFileStatus::Modified,
        ('.', 'A') | ('A', '.') | ('A', _) => AppFileStatus::New,
        ('.', 'D') | ('D', '.') => AppFileStatus::Deleted,
        ('R', _) | ('.', 'R') => AppFileStatus::Renamed {
            old_path: entry.old_path.clone().unwrap_or_else(|| entry.path.clone()),
        },
        ('C', _) | ('.', 'C') => AppFileStatus::Copied {
            old_path: entry.old_path.clone().unwrap_or_else(|| entry.path.clone()),
        },
        _ => AppFileStatus::Modified,
    }
}

/// Reads the working directory status of a repository.
pub async fn get_status(
    runner: &GitRunner,
    path: &str,
    include_untracked: bool,
) -> Result<IStatusResult, ApiError> {
    let mut args: Vec<String> = vec![
        "--no-optional-locks".to_string(),
        "status".to_string(),
    ];

    if include_untracked {
        args.push("--untracked-files=all".to_string());
    }

    args.push("--branch".to_string());
    args.push("--porcelain=2".to_string());
    args.push("-z".to_string());

    // Exit code 128 covers both "this path is not a repository" and git
    // refusing to touch a bare/permission-denied repository; only the former
    // is reported as a repository that doesn't exist.
    let output = match runner.run_in_vec(path, args).await {
        Ok(output) => output,
        Err(ApiError::GitError { code: 128, stderr, .. }) if is_missing_repository(&stderr) => {
            return Ok(IStatusResult {
                current_branch: None,
                current_upstream_branch: None,
                current_tip: None,
                branch_ahead_behind: None,
                exists: false,
                merge_head_found: false,
                squash_msg_found: false,
                is_cherry_picking_head_found: false,
                working_directory: WorkingDirectoryStatus {
                    files: Vec::new(),
                    include_all: None,
                },
                do_conflicted_files_exist: false,
            });
        }
        Err(error) => return Err(error),
    };

    let parsed = parse_status(&output.stdout_str());

    // `--branch` already reports the ahead/behind counts as `branch.ab`, which
    // is authoritative: an extra `rev-list` here would race a concurrent fetch
    // and could get the two sides the wrong way round.
    let branch_ahead_behind = parsed.headers.branch_ahead_behind;

    let files = parsed
        .entries
        .iter()
        .map(|entry| {
            let mut change = FileChange::new(entry.path.clone(), map_status(entry));
            change.submodule_status = entry.submodule_status();
            change
        })
        .collect();

    let do_conflicted_files_exist = parsed
        .entries
        .iter()
        .any(|entry| map_status(entry).is_conflicted());

    Ok(IStatusResult {
        current_branch: parsed.headers.current_branch,
        current_upstream_branch: parsed.headers.current_upstream_branch,
        current_tip: parsed.headers.current_tip,
        branch_ahead_behind,
        exists: true,
        merge_head_found: marker_found(runner, path, "MERGE_HEAD").await?,
        squash_msg_found: marker_found(runner, path, "SQUASH_MSG").await?,
        is_cherry_picking_head_found: marker_found(runner, path, "CHERRY_PICK_HEAD").await?,
        working_directory: WorkingDirectoryStatus {
            files,
            include_all: None,
        },
        do_conflicted_files_exist,
    })
}

/// Whether the given `.git` marker file exists (MERGE_HEAD, SQUASH_MSG, ...).
async fn marker_found(runner: &GitRunner, path: &str, marker: &str) -> Result<bool, ApiError> {
    let git_dir = git_dir(runner, path).await?;

    Ok(git_dir.join(marker).exists())
}

/// The absolute path of the repository's git directory.
pub async fn git_dir(runner: &GitRunner, path: &str) -> Result<std::path::PathBuf, ApiError> {
    let output = runner
        .run_in_vec(
            path,
            vec![
                "rev-parse".to_string(),
                "--absolute-git-dir".to_string(),
            ],
        )
        .await?;

    Ok(std::path::PathBuf::from(output.stdout_str().trim()))
}

/// Stages the given files.
pub async fn stage_files(runner: &GitRunner, path: &str, files: &[String]) -> Result<(), ApiError> {
    let args = build_pathspec("add", files);
    runner.run_in_vec(path, args).await.map(|_| ())
}

/// Unstages the given files.
pub async fn unstage_files(runner: &GitRunner, path: &str, files: &[String]) -> Result<(), ApiError> {
    let mut args = vec!["reset".to_string(), "-q".to_string(), "--".to_string()];
    args.extend(files.iter().cloned());

    runner.run_in_vec(path, args).await.map(|_| ())
}

/// Unstages everything in the index.
pub async fn unstage_all(runner: &GitRunner, path: &str) -> Result<(), ApiError> {
    runner
        .run_in(path, &["reset", "-q"])
        .await
        .map(|_| ())
}

/// Discards changes to the given files, deleting untracked ones from disk.
///
/// `files` are paths relative to the repository root; which of them are
/// untracked is decided by asking git rather than trusting the client.
pub async fn discard_files(
    runner: &GitRunner,
    path: &str,
    files: &[String],
    include_untracked: bool,
) -> Result<(), ApiError> {
    if files.is_empty() {
        return Ok(());
    }

    // Files which are not in the index (and are not ignored).
    let untracked_output = runner
        .run_in_vec(path, ls_files_args(true, files))
        .await?;

    let untracked: std::collections::HashSet<String> =
        split_nul(&untracked_output.stdout_str()).into_iter().collect();

    let tracked_output = runner
        .run_in_vec(path, ls_files_args(false, files))
        .await?;

    let tracked = split_nul(&tracked_output.stdout_str());

    // Restore the tracked files first: deleting the untracked ones first would
    // leave the working tree half-destroyed if the checkout then failed.
    if !tracked.is_empty() {
        let mut args = vec!["checkout".to_string(), "--".to_string()];
        args.extend(tracked);

        runner.run_in_vec(path, args).await.map(|_| ())?;
    }

    if include_untracked {
        for file in files {
            if !untracked.contains(file) {
                continue;
            }

            let full_path = std::path::Path::new(path).join(file);

            if full_path.is_dir() {
                std::fs::remove_dir_all(&full_path)?;
            } else if full_path.exists() {
                std::fs::remove_file(&full_path)?;
            }
        }
    }

    Ok(())
}

/// Builds the argv for a `git ls-files` call restricted to a set of files.
fn ls_files_args(untracked_only: bool, files: &[String]) -> Vec<String> {
    let mut args = vec!["ls-files".to_string(), "-z".to_string()];

    if untracked_only {
        args.push("--others".to_string());
        args.push("--exclude-standard".to_string());
    }

    args.push("--".to_string());
    args.extend(files.iter().cloned());

    args
}

/// Builds `git <command> -- <paths...>` argv.
pub(crate) fn build_pathspec(command: &str, files: &[String]) -> Vec<String> {
    let mut args = vec![command.to_string(), "--".to_string()];
    args.extend(files.iter().cloned());
    args
}
