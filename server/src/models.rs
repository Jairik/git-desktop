//! The JSON data shapes shared with the client.
//!
//! Every type here maps 1:1 onto the shapes documented in
//! `docs/architecture/server-client.md`. Field names are `camelCase` and
//! unions are discriminated by a `kind` string.

use serde::{Deserialize, Serialize};

/// A repository the client knows about, persisted in the store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    /// Stable identifier — the canonical absolute path of the repository.
    pub id: String,
    /// The absolute path the repository was opened with.
    pub path: String,
    /// Optional user-supplied label.
    pub alias: Option<String>,
    /// True when the path no longer exists on disk.
    pub missing: bool,
}

/// The kind of repository found at a given path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RepositoryType {
    /// A regular repository with a working tree.
    Regular {
        #[serde(rename = "topLevelWorkingDirectory")]
        top_level_working_directory: String,
        #[serde(rename = "gitDir")]
        git_dir: String,
    },
    /// A bare repository (no working tree).
    Bare {
        #[serde(rename = "gitDir")]
        git_dir: String,
    },
    /// Nothing usable exists at the path.
    Missing,
    /// The path is inside a repository owned by another user.
    Unsafe { path: String },
}

/// Status of a submodule as reported by `git status --porcelain=2`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    /// Whether the checked out commit differs from the recorded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_changed: Option<bool>,
    /// Whether the submodule has modified (tracked) contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_changes: Option<bool>,
    /// Whether the submodule has untracked contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub untracked_changes: Option<bool>,
}

/// The `conflictedEntry` payload of a conflicted file status.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConflictedEntry {
    /// A file with unresolved merge conflicts.
    Conflicted,
}

/// The status of a single file in the working directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AppFileStatus {
    /// A newly added file.
    New,
    /// A modified file.
    Modified,
    /// A deleted file.
    Deleted,
    /// A renamed file.
    Renamed {
        /// The previous path of the file.
        #[serde(rename = "oldPath")]
        old_path: String,
    },
    /// A copied file.
    Copied {
        /// The path the file was copied from.
        #[serde(rename = "oldPath")]
        old_path: String,
    },
    /// A file with unresolved conflicts.
    Conflicted {
        /// Conflict details (folded into `{ kind: "conflicted" }` for v1).
        #[serde(rename = "conflictedEntry")]
        conflicted_entry: ConflictedEntry,
    },
    /// A file which is not tracked by git.
    Untracked,
    /// Any status we don't model explicitly; treated as modified.
    #[serde(other)]
    Unknown,
}

impl AppFileStatus {
    /// True when the file has unresolved conflicts.
    pub fn is_conflicted(&self) -> bool {
        matches!(self, AppFileStatus::Conflicted { .. })
    }

    /// The path a file was renamed or copied from, when applicable.
    pub fn old_path(&self) -> Option<&str> {
        match self {
            AppFileStatus::Renamed { old_path } | AppFileStatus::Copied { old_path } => {
                Some(old_path.as_str())
            }
            _ => None,
        }
    }
}

/// A single file change inside a working directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// The file path (matches legacy, which uses the path as the id).
    pub id: String,
    /// The path of the file relative to the repository root.
    pub path: String,
    /// The status of the file.
    pub status: AppFileStatus,
    /// Submodule status, when the entry is a submodule.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submodule_status: Option<SubmoduleStatus>,
}

impl FileChange {
    /// Creates a new file change entry.
    pub fn new(path: impl Into<String>, status: AppFileStatus) -> Self {
        let path = path.into();
        FileChange {
            id: path.clone(),
            path,
            status,
            submodule_status: None,
        }
    }
}

/// The set of changed files in a working directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDirectoryStatus {
    /// The changed files.
    pub files: Vec<FileChange>,
    /// Whether all files are included (always null for v1).
    pub include_all: Option<bool>,
}

/// How many commits a branch is ahead/behind another.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    /// Commits reachable from the branch but not the upstream.
    pub ahead: u32,
    /// Commits reachable from the upstream but not the branch.
    pub behind: u32,
}

/// The result of `status.get`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IStatusResult {
    /// The name of the checked out branch, or null when detached.
    pub current_branch: Option<String>,
    /// The upstream of the current branch, if any.
    pub current_upstream_branch: Option<String>,
    /// The tip of the current branch.
    pub current_tip: Option<String>,
    /// How far the current branch is from its upstream.
    pub branch_ahead_behind: Option<AheadBehind>,
    /// Whether the repository exists.
    pub exists: bool,
    /// Whether a merge is in progress.
    pub merge_head_found: bool,
    /// Whether a `merge --squash` is in progress.
    pub squash_msg_found: bool,
    /// Whether a cherry-pick is in progress.
    pub is_cherry_picking_head_found: bool,
    /// The working directory contents.
    pub working_directory: WorkingDirectoryStatus,
    /// Whether any conflicted files are present.
    pub do_conflicted_files_exist: bool,
}

/// A local or remote branch.
///
/// Only `name` and `type` are required when a client sends a branch back to us
/// (for example to delete one); the remaining fields default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// The short name of the branch.
    pub name: String,
    /// The full ref name.
    #[serde(rename = "ref", default)]
    pub ref_: String,
    /// The upstream ref of the branch, if any.
    #[serde(default)]
    pub upstream: Option<String>,
    /// The tip of the branch.
    #[serde(default)]
    pub tip: Tip,
    /// Whether this is a local or remote branch.
    #[serde(rename = "type", default)]
    pub branch_type: BranchType,
}

/// The tip commit of a branch.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tip {
    /// The SHA of the tip commit.
    #[serde(default)]
    pub sha: String,
}

/// Local or remote branch.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchType {
    /// A local branch (`refs/heads/*`).
    #[default]
    Local,
    /// A remote-tracking branch (`refs/remotes/*`).
    Remote,
}

/// A git remote.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    /// The name of the remote.
    pub name: String,
    /// The URL of the remote.
    pub url: String,
}

/// A (name, email, date, timezone) tuple used for authors and committers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    /// The name.
    pub name: String,
    /// The email.
    pub email: String,
    /// ISO-8601 formatted date.
    pub date: String,
    /// Timezone offset from UTC in minutes.
    pub tz_offset: i32,
}

/// A commit from `git log`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// The full SHA.
    pub sha: String,
    /// The abbreviated SHA.
    pub short_sha: String,
    /// The summary line.
    pub summary: String,
    /// The body of the commit message.
    pub body: String,
    /// The author identity.
    pub author: CommitIdentity,
    /// The committer identity.
    pub committer: CommitIdentity,
    /// The SHAs of the parent commits.
    #[serde(rename = "parentSHAs")]
    pub parent_shas: Vec<String>,
    /// Tags pointing at this commit.
    pub tags: Vec<String>,
}

/// A single line of commit history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitOneLine {
    /// The full SHA.
    pub sha: String,
    /// The summary line.
    pub summary: String,
}

/// An entry in the desktop stash list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// The full stash message (including the desktop marker).
    pub name: String,
    /// The branch the stash was created from.
    pub branch_name: String,
    /// The SHA of the stash commit.
    pub stash_sha: String,
}

/// The kind of a line in a unified diff.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineType {
    /// An unchanged line.
    Context,
    /// An added line.
    Add,
    /// A deleted line.
    Delete,
    /// A hunk header.
    Hunk,
}

/// A single line of a text diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// The kind of line.
    #[serde(rename = "type")]
    pub diff_type: DiffLineType,
    /// The raw text of the line, without the leading diff marker.
    pub text: String,
    /// The line number in the old file, if any.
    pub old_line_number: Option<u32>,
    /// The line number in the new file, if any.
    pub new_line_number: Option<u32>,
}

/// A hunk of a text diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The raw hunk header line (e.g. `@@ -1,3 +1,4 @@`).
    pub header: String,
    /// The first line of the hunk in the old file.
    pub old_start_line: u32,
    /// The number of lines the hunk covers in the old file.
    pub old_line_count: u32,
    /// The first line of the hunk in the new file.
    pub new_start_line: u32,
    /// The number of lines the hunk covers in the new file.
    pub new_line_count: u32,
    /// The lines of the hunk.
    pub lines: Vec<DiffLine>,
}

/// A text diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    /// The raw text of the diff (without the header).
    pub text: String,
    /// The parsed hunks.
    pub hunks: Vec<Hunk>,
    /// A description of a line-ending conversion, if git warned about one.
    pub line_endings_change: Option<String>,
}

/// A diff too large to render by default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LargeTextDiff {
    /// The raw text of the diff.
    pub text: String,
}

/// Base64 encoded image contents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    /// The base64 encoded contents of the image.
    pub contents: String,
    /// The media type of the image (e.g. `image/png`).
    pub media_type: String,
    /// The size of the image in bytes.
    pub bytes: u64,
}

/// A diff between two versions of an image.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageDiff {
    /// The previous version of the image, if any.
    pub previous: Option<ImageData>,
    /// The current version of the image, if any.
    pub current: Option<ImageData>,
}

/// A diff of a file git considers binary.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDiff {}

/// A diff of a submodule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleDiff {
    /// The absolute path of the submodule.
    pub full_path: String,
    /// The configured URL of the submodule, if any.
    pub url: Option<String>,
    /// The submodule status.
    pub status: String,
    /// The SHA recorded before the change.
    #[serde(rename = "oldSHA")]
    pub old_sha: String,
    /// The SHA recorded after the change.
    #[serde(rename = "newSHA")]
    pub new_sha: String,
}

/// A diff the server refuses to render.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnrenderableDiff {
    /// Why the diff could not be rendered.
    pub reason: Option<String>,
}

/// The discriminated union of all diff kinds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Diff {
    /// A text diff.
    Text(TextDiff),
    /// A large text diff.
    LargeText(LargeTextDiff),
    /// An image diff.
    Image(ImageDiff),
    /// A binary diff.
    Binary(BinaryDiff),
    /// A submodule diff.
    Submodule(SubmoduleDiff),
    /// A diff which could not be rendered.
    Unrenderable(UnrenderableDiff),
}

/// The result of `log.changedFiles`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFilesResult {
    /// The files changed by the commit.
    pub files: Vec<FileChange>,
    /// The number of added lines.
    pub lines_added: i64,
    /// The number of deleted lines.
    pub lines_deleted: i64,
}

/// A commit message supplied by the client.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    /// The summary line of the message.
    pub summary: String,
    /// The body of the message.
    #[serde(default)]
    pub description: String,
}

/// The result of `github.status` — whether the `gh` CLI can be used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    /// Whether the `gh` CLI is installed on the server's PATH.
    pub available: bool,
    /// Whether `gh` is authenticated (`gh auth token` succeeds).
    pub authenticated: bool,
    /// The authenticated GitHub login, resolved best-effort (null on failure).
    pub user: Option<String>,
}

/// The `origin` GitHub remote of a repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRemote {
    /// The repository owner (a user or an organization).
    pub owner: String,
    /// The repository name.
    pub name: String,
    /// The remote hostname (e.g. `github.com`).
    pub hostname: String,
}

/// The author of a pull request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    /// The GitHub login of the author.
    pub login: String,
}

/// A pull request summary, as returned by `pr.list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// The pull request number.
    pub number: i64,
    /// The title.
    pub title: String,
    /// The normalized state: `open`, `closed` or `merged`.
    pub state: String,
    /// Whether the pull request is a draft.
    pub is_draft: bool,
    /// The web URL of the pull request.
    pub url: String,
    /// The name of the head (source) branch.
    pub head_ref_name: String,
    /// The name of the base (target) branch.
    pub base_ref_name: String,
    /// The author, or null when it could not be resolved.
    pub author: Option<Author>,
    /// The ISO-8601 creation timestamp.
    pub created_at: String,
    /// The ISO-8601 last-updated timestamp.
    pub updated_at: String,
    /// Lines added.
    pub additions: i64,
    /// Lines deleted.
    pub deletions: i64,
    /// Number of changed files.
    pub changed_files: i64,
    /// gh's mergeable state (`MERGEABLE`, `CONFLICTED`, ...) or null.
    pub mergeable: Option<String>,
}

/// A pull request with its detail fields, as returned by `pr.view`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    /// The pull request fields shared with [`PullRequest`].
    #[serde(flatten)]
    pub base: PullRequest,
    /// The pull request body (Markdown); may be empty.
    pub body: String,
    /// The number of comments (gh reports a list, an object or a count).
    pub comments: i64,
    /// The review decision (`APPROVED`, `CHANGES_REQUESTED`, ...) or null.
    pub review_decision: Option<String>,
    /// The SHA of the head commit, or null.
    pub head_sha: Option<String>,
}

/// A single CI check: a GitHub check run or a legacy commit status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// The name of the check.
    pub name: String,
    /// The normalized status: `queued`, `in_progress` or `completed`.
    pub status: String,
    /// The normalized conclusion (`success`, `failure`, ...) or null.
    pub conclusion: Option<String>,
    /// A link to the check's details page, or null.
    pub details_url: Option<String>,
    /// The ISO-8601 start time, or null.
    pub started_at: Option<String>,
    /// The ISO-8601 completion time, or null.
    pub completed_at: Option<String>,
    /// The source of the check: `check_run` or `status`.
    pub kind: String,
}

/// The combined CI status of a commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    /// The SHA the checks were resolved against, or null.
    pub head_sha: Option<String>,
    /// The rolled-up state: `success`, `pending` or `failure`.
    pub roll_up: String,
    /// The individual checks (check runs first, then commit statuses).
    pub checks: Vec<Check>,
}
