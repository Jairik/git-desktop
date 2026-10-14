//! Diff computation and unified-diff parsing.
//!
//! Diffs are produced by shelling out to `git diff`/`git log -p` and parsing
//! the GNU unified diff format into the `Hunk`/`DiffLine` shapes from the
//! server-client contract. Classification (binary, image, large text) mirrors
//! the legacy `convertDiff`/`buildDiff` pipeline.

use serde::Deserialize;

use base64::Engine;

use super::{split_nul, GitRunner};
use crate::error::ApiError;
use crate::models::{
    AppFileStatus, Diff, DiffLine, DiffLineType, Hunk, ImageData, ImageDiff, SubmoduleDiff,
    SubmoduleStatus, TextDiff,
};

/// The number of lines after which a text diff is reported as `largeText`.
const MAX_TEXT_DIFF_LINES: usize = 8_000;
/// The size (in bytes) after which a text diff is reported as `largeText`.
const MAX_TEXT_DIFF_BYTES: usize = 256 * 1024;

/// The state a diff is computed against.
#[derive(Debug, Clone)]
pub enum DiffSource {
    /// The working directory (unstaged and staged changes).
    WorkingDirectory,
    /// A commit compared against its first parent.
    Commit(String),
    /// A file as recorded in a stash entry.
    Stash(String),
}

/// A file reference as sent by the client: `{ path, status? }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRefParams {
    /// The path of the file relative to the repository root.
    pub path: String,
    /// The status of the file, when the client knows it.
    #[serde(default)]
    pub status: Option<AppFileStatus>,
    /// The submodule status of the file, when it is a submodule.
    #[serde(default, rename = "submoduleStatus")]
    pub submodule_status: Option<SubmoduleStatus>,
}

impl From<FileRefParams> for FileRef {
    fn from(params: FileRefParams) -> Self {
        FileRef {
            path: params.path,
            status: params.status,
            submodule_status: params.submodule_status,
        }
    }
}

/// The minimal description of a file the client wants a diff for.
#[derive(Debug, Clone)]
pub struct FileRef {
    /// The path of the file relative to the repository root.
    pub path: String,
    /// The status of the file, when the client knows it.
    pub status: Option<AppFileStatus>,
    /// The submodule status of the file, when it is a submodule.
    pub submodule_status: Option<SubmoduleStatus>,
}

impl FileRef {
    /// Whether the client told us this entry is a submodule.
    fn is_submodule(&self) -> bool {
        self.submodule_status.is_some()
    }

    /// The path a renamed/copied file used to live at.
    fn old_path(&self) -> Option<&str> {
        self.status.as_ref().and_then(|status| status.old_path())
    }
}

/// Computes the diff for a file in the working directory.
pub async fn working_directory_diff(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
    hide_whitespace: bool,
) -> Result<Diff, ApiError> {
    let args = diff_args(DiffSource::WorkingDirectory, file, hide_whitespace, false);
    let numstat_args = diff_args(DiffSource::WorkingDirectory, file, false, true);

    build_diff(runner, path, file, &DiffSource::WorkingDirectory, args, numstat_args).await
}

/// Computes the diff for a file as changed by a commit.
pub async fn commit_diff(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
    commitish: &str,
) -> Result<Diff, ApiError> {
    let source = DiffSource::Commit(commitish.to_string());
    let args = diff_args(source.clone(), file, false, false);
    let numstat_args = diff_args(source.clone(), file, false, true);

    build_diff(runner, path, file, &source, args, numstat_args).await
}

/// Computes the diff for a file as recorded in a stash entry.
pub async fn stash_diff(
    runner: &GitRunner,
    path: &str,
    stash_sha: &str,
    file: &FileRef,
) -> Result<Diff, ApiError> {
    let source = DiffSource::Stash(stash_sha.to_string());
    let args = diff_args(source.clone(), file, false, false);
    let numstat_args = diff_args(source.clone(), file, false, true);

    build_diff(runner, path, file, &source, args, numstat_args).await
}

/// The fast path used by the client for image files in the working directory.
pub async fn working_directory_image_diff(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
) -> Result<ImageDiff, ApiError> {
    Ok(ImageDiff {
        previous: working_directory_image_previous(runner, path, file).await?,
        current: working_directory_image_current(path, file).await?,
    })
}

/// Builds the argv for a `git diff`-like call for a single file.
fn diff_args(source: DiffSource, file: &FileRef, hide_whitespace: bool, numstat: bool) -> Vec<String> {
    let mut args = vec!["diff".to_string()];

    if hide_whitespace {
        args.push("-w".to_string());
    }

    args.push("--no-ext-diff".to_string());
    args.push("--no-color".to_string());

    if numstat {
        args.push("--numstat".to_string());
    }

    args.push("-z".to_string());

    let new_or_untracked = matches!(
        file.status.as_ref(),
        Some(AppFileStatus::New | AppFileStatus::Untracked)
    );

    let mut paths = Vec::new();

    match &source {
        DiffSource::WorkingDirectory => {
            if new_or_untracked {
                // `git diff --no-index` uses `diff(1)` exit codes: 0 means no
                // changes, 1 means changes were found.
                args.push("--no-index".to_string());
                paths.push("/dev/null".to_string());
                paths.push(file.path.clone());
            } else if matches!(
                file.status.as_ref(),
                Some(AppFileStatus::Renamed { .. })
            ) {
                // Diff the rename against the index so we see the modification
                // state of the new path.
                paths.push(file.path.clone());
            } else {
                args.push("HEAD".to_string());
                paths.push(file.path.clone());
            }
        }
        DiffSource::Commit(commitish) => {
            // `log -p` (rather than `diff`) is what lets us handle the root
            // commit, where the diff is against the empty tree.
            let mut log_args = vec![
                "log".to_string(),
                commitish.clone(),
                "-m".to_string(),
                "-1".to_string(),
                "--first-parent".to_string(),
            ];

            if !numstat {
                log_args.push("-p".to_string());
            } else {
                log_args.push("--numstat".to_string());
            }

            log_args.push("--no-color".to_string());
            log_args.push("-z".to_string());
            log_args.push("--format=".to_string());
            log_args.push("--".to_string());

            if let Some(old_path) = file.old_path() {
                log_args.push(old_path.to_string());
            }

            log_args.push(file.path.clone());

            return log_args;
        }
        DiffSource::Stash(stash_sha) => {
            args.push(format!("{stash_sha}^"));
            args.push(stash_sha.clone());
            paths.push(file.path.clone());
        }
    }

    args.push("--".to_string());
    args.extend(paths);

    args
}

/// Runs the diff and classifies it into the `Diff` union.
async fn build_diff(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
    source: &DiffSource,
    args: Vec<String>,
    numstat_args: Vec<String>,
) -> Result<Diff, ApiError> {
    if file.is_submodule() {
        return build_submodule_diff(runner, path, file, args).await;
    }

    // New and untracked files are diffed with `--no-index`, which exits with 1
    // when it finds differences.
    let is_no_index = matches!(source, DiffSource::WorkingDirectory)
        && matches!(
            file.status.as_ref(),
            Some(AppFileStatus::New | AppFileStatus::Untracked)
        );

    let mut opts = crate::git::RunOptions {
        path: Some(path.to_string()),
        args: args.clone(),
        stdin: None,
        success_codes: None,
    };

    if is_no_index {
        opts = opts.success_codes(&[0, 1]);
    }

    let output = runner.run(opts).await?;
    let patch = output.stdout_str();

    let is_binary = is_binary_in_diff(runner, path, &numstat_args, is_no_index).await?;

    if is_binary {
        if is_image(&file.path) {
            return image_diff_for(runner, path, file, source).await;
        }

        return Ok(Diff::Binary(crate::models::BinaryDiff {}));
    }

    let (text, hunks) = parse_text_diff(&patch);

    if patch.len() > MAX_TEXT_DIFF_BYTES || text.lines().count() > MAX_TEXT_DIFF_LINES {
        return Ok(Diff::LargeText(crate::models::LargeTextDiff { text }));
    }

    Ok(Diff::Text(TextDiff {
        text,
        hunks,
        line_endings_change: parse_line_endings_change(&output.stderr),
    }))
}

/// Determines whether git treats the file as binary, using `--numstat`.
///
/// A binary file shows up as `-\t-` in numstat output.
async fn is_binary_in_diff(
    runner: &GitRunner,
    path: &str,
    numstat_args: &[String],
    is_no_index: bool,
) -> Result<bool, ApiError> {
    let mut opts = crate::git::RunOptions {
        path: Some(path.to_string()),
        args: numstat_args.to_vec(),
        stdin: None,
        success_codes: None,
    };

    if is_no_index {
        opts = opts.success_codes(&[0, 1]);
    }

    let output = runner.run(opts).await?;
    let tokens = split_nul(&output.stdout_str());

    // The pathspec scopes the command to a single file, so any `-\t-` record
    // means that file is binary.
    Ok(tokens.iter().any(|token| token.starts_with("-\t-")))
}

/// Builds the submodule diff for a submodule entry.
async fn build_submodule_diff(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
    args: Vec<String>,
) -> Result<Diff, ApiError> {
    let output = runner
        .run(crate::git::RunOptions {
            path: Some(path.to_string()),
            args,
            stdin: None,
            success_codes: None,
        })
        .await?;

    let patch = output.stdout_str();

    let status = file
        .submodule_status
        .as_ref()
        .map(|status| {
            if status.commit_changed == Some(true) {
                "commit changed".to_string()
            } else if status.modified_changes == Some(true) {
                "modified".to_string()
            } else if status.untracked_changes == Some(true) {
                "untracked".to_string()
            } else {
                "modified".to_string()
            }
        })
        .unwrap_or_else(|| "modified".to_string());

    let url = super::config::get_config_value(
        runner,
        Some(path),
        &format!("submodule.{}.url", file.path),
        true,
    )
    .await
    .ok()
    .flatten();

    let old_sha = capture_subproject_sha(&patch, '-');
    let new_sha = capture_subproject_sha(&patch, '+');

    Ok(Diff::Submodule(SubmoduleDiff {
        full_path: format!("{}/{}", path.trim_end_matches('/'), file.path),
        url,
        status,
        old_sha,
        new_sha,
    }))
}

/// Extracts a `Subproject commit <sha>` line for the given marker (`+`/`-`).
fn capture_subproject_sha(patch: &str, marker: char) -> String {
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix(marker) {
            if let Some(sha) = rest.strip_prefix("Subproject commit ") {
                return sha.trim_end_matches("-dirty").to_string();
            }
        }
    }

    String::new()
}

/// Builds the image diff for a file, depending on the source of the diff.
async fn image_diff_for(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
    source: &DiffSource,
) -> Result<Diff, ApiError> {
    match source {
        DiffSource::WorkingDirectory => Ok(Diff::Image(
            working_directory_image_diff(runner, path, file).await?,
        )),
        DiffSource::Commit(commitish) => {
            let status = file.status.as_ref();

            let new_or_untracked = matches!(
                status,
                Some(AppFileStatus::New | AppFileStatus::Untracked)
            );
            let deleted = matches!(status, Some(AppFileStatus::Deleted));

            let current = if deleted {
                None
            } else {
                blob_image(runner, path, &file.path, commitish).await?
            };

            let previous = if new_or_untracked {
                None
            } else {
                let old_path = file.old_path().unwrap_or(&file.path);
                // The root commit has no parent, so `commitish^` fails — in that
                // case there's nothing to compare against.
                blob_image(runner, path, old_path, &format!("{commitish}^"))
                    .await
                    .unwrap_or(None)
            };

            Ok(Diff::Image(ImageDiff { previous, current }))
        }
        DiffSource::Stash(stash_sha) => {
            let previous = blob_image(runner, path, &file.path, &format!("{stash_sha}^")).await?;
            let current = blob_image(runner, path, &file.path, stash_sha).await?;

            Ok(Diff::Image(ImageDiff { previous, current }))
        }
    }
}

/// The current (working tree) side of an image diff.
async fn working_directory_image_current(
    path: &str,
    file: &FileRef,
) -> Result<Option<ImageData>, ApiError> {
    if matches!(
        file.status.as_ref(),
        Some(AppFileStatus::Deleted) | Some(AppFileStatus::Conflicted { .. })
    ) {
        return Ok(None);
    }

    let full_path = std::path::Path::new(path).join(&file.path);
    let bytes = read_file_async(full_path).await?;

    Ok(Some(image_data(&file.path, &bytes)))
}

/// The previous (HEAD) side of an image diff.
async fn working_directory_image_previous(
    runner: &GitRunner,
    path: &str,
    file: &FileRef,
) -> Result<Option<ImageData>, ApiError> {
    if matches!(
        file.status.as_ref(),
        Some(AppFileStatus::New | AppFileStatus::Untracked)
    ) {
        return Ok(None);
    }

    let old_path = file.old_path().unwrap_or(&file.path);

    Ok(blob_image(runner, path, old_path, "HEAD").await?)
}

/// Reads the base64 encoded contents of a blob from the object database.
async fn blob_image(
    runner: &GitRunner,
    path: &str,
    file_path: &str,
    commitish: &str,
) -> Result<Option<ImageData>, ApiError> {
    let output = runner
        .run_in_vec(
            path,
            vec![
                "cat-file".to_string(),
                "blob".to_string(),
                format!("{commitish}:{file_path}"),
            ],
        )
        .await;

    match output {
        Ok(output) => Ok(Some(image_data(file_path, &output.stdout))),
        // The blob doesn't exist (deleted file, unborn branch, ...).
        Err(_) => Ok(None),
    }
}

/// Reads a file off disk without blocking the runtime.
async fn read_file_async(path: std::path::PathBuf) -> Result<Vec<u8>, ApiError> {
    let result = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|error| ApiError::internal(format!("file read task failed: {error}")))?;

    result.map_err(ApiError::from)
}

/// Wraps raw image bytes into [`ImageData`].
fn image_data(path: &str, bytes: &[u8]) -> ImageData {
    ImageData {
        contents: base64::engine::general_purpose::STANDARD.encode(bytes),
        media_type: media_type(path).to_string(),
        bytes: bytes.len() as u64,
    }
}

/// Whether the file extension is one we know how to render as an image.
pub fn is_image(path: &str) -> bool {
    let extension = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "ico" | "webp" | "bmp" | "avif"
    )
}

/// Maps a file extension onto a media type, falling back to `text/plain`.
pub fn media_type(path: &str) -> &'static str {
    let extension = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "text/plain",
    }
}

/// Extracts the line ending warning git writes to stderr, if any.
///
/// Git warns with `'<X>' will be replaced by '<Y>'` when it believes a file's
/// line endings are about to change; we surface that as a short string.
fn parse_line_endings_change(stderr: &str) -> Option<String> {
    for line in stderr.lines() {
        if line.contains("will be replaced by") {
            return Some(line.trim().to_string());
        }
    }

    None
}

/// A parsed hunk header: `@@ -old,count +new,count @@`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HunkHeader {
    /// The first line of the hunk in the old file.
    pub old_start_line: u32,
    /// The number of lines covered in the old file.
    pub old_line_count: u32,
    /// The first line of the hunk in the new file.
    pub new_start_line: u32,
    /// The number of lines covered in the new file.
    pub new_line_count: u32,
}

/// Parses the four numbers out of a unified diff hunk header.
pub fn parse_hunk_header(line: &str) -> HunkHeader {
    let empty = HunkHeader {
        old_start_line: 0,
        old_line_count: 0,
        new_start_line: 0,
        new_line_count: 0,
    };

    let Some(rest) = line.strip_prefix("@@ ") else {
        return empty;
    };

    let Some(end) = rest.find("@@") else {
        return empty;
    };

    let mut ranges = rest[..end].split_whitespace();

    let (old_start_line, old_line_count) =
        ranges.next().and_then(parse_range).unwrap_or((0, 0));
    let (new_start_line, new_line_count) =
        ranges.next().and_then(parse_range).unwrap_or((0, 0));

    HunkHeader {
        old_start_line,
        old_line_count,
        new_start_line,
        new_line_count,
    }
}

/// Parses `-<start>[,<count>]` / `+<start>[,<count>]`.
fn parse_range(value: &str) -> Option<(u32, u32)> {
    let value = value.strip_prefix('-').or_else(|| value.strip_prefix('+'))?;

    match value.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        // A missing count means the range covers exactly one line.
        None => Some((value.parse().ok()?, 1)),
    }
}

/// Strips the leading `+`/`-`/space marker from a diff line.
///
/// The contract reports `text` without the marker (it can be recovered from
/// `type`), while the hunk's raw `contents` keeps it.
fn strip_marker(line: &str) -> String {
    line.get(1..).unwrap_or_default().to_string()
}

/// Parses a unified diff into its body text and hunks.
///
/// The returned text is the diff without its `diff --git` header, matching the
/// legacy parser's `contents`.
pub fn parse_text_diff(text: &str) -> (String, Vec<Hunk>) {
    let lines: Vec<&str> = text.split('\n').collect();

    let mut index = 0;
    while index < lines.len() && !lines[index].starts_with("@@ ") {
        index += 1;
    }

    if index >= lines.len() {
        return (String::new(), Vec::new());
    }

    let mut contents = String::new();
    let mut hunks = Vec::new();

    while index < lines.len() {
        if !lines[index].starts_with("@@ ") {
            index += 1;
            continue;
        }

        let header_line = lines[index].to_string();
        let parsed = parse_hunk_header(&header_line);

        let mut hunk_lines = vec![DiffLine {
            diff_type: DiffLineType::Hunk,
            text: header_line.clone(),
            old_line_number: None,
            new_line_number: None,
        }];

        if !contents.is_empty() {
            contents.push('\n');
        }
        contents.push_str(&header_line);

        index += 1;

        let mut old_line_number = parsed.old_start_line;
        let mut new_line_number = parsed.new_start_line;

        while index < lines.len() {
            let line = lines[index];
            let marker = line.chars().next().unwrap_or('\0');

            let diff_line = match marker {
                ' ' => {
                    old_line_number += 1;
                    new_line_number += 1;
                    Some(DiffLine {
                        diff_type: DiffLineType::Context,
                        text: strip_marker(line),
                        old_line_number: Some(old_line_number - 1),
                        new_line_number: Some(new_line_number - 1),
                    })
                }
                '+' => {
                    new_line_number += 1;
                    Some(DiffLine {
                        diff_type: DiffLineType::Add,
                        text: strip_marker(line),
                        old_line_number: None,
                        new_line_number: Some(new_line_number - 1),
                    })
                }
                '-' => {
                    old_line_number += 1;
                    Some(DiffLine {
                        diff_type: DiffLineType::Delete,
                        text: strip_marker(line),
                        old_line_number: Some(old_line_number - 1),
                        new_line_number: None,
                    })
                }
                // `\ No newline at end of file` — a marker, not a diff line.
                '\\' => None,
                _ => break,
            };

            index += 1;

            if let Some(diff_line) = diff_line {
                contents.push('\n');
                contents.push_str(line);
                hunk_lines.push(diff_line);
            }
        }

        hunks.push(Hunk {
            header: header_line,
            old_start_line: parsed.old_start_line,
            old_line_count: parsed.old_line_count,
            new_start_line: parsed.new_start_line,
            new_line_count: parsed.new_line_count,
            lines: hunk_lines,
        });
    }

    (contents, hunks)
}
