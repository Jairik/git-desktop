# Server–Client Contract (v1)

This is the **single source of truth** for how the Rust backend (`server/`) and the
React client (`client/`) talk. Both sides MUST match this document exactly. If you
change it, change it here first, then update both sides.

The product is a **minimal local Git client**. It is deliberately free of
GitHub-specific concerns (no GitHub API/auth/PRs/copilot). The git engine stays a
git engine — the server shells out to the `git` CLI behind a clean abstraction.

---

## Transport

- **Request/response:** JSON-RPC-style over HTTP.
  - `POST /rpc` with body: `{ "id": <number>, "method": <string>, "params": <object> }`
  - Success: `{ "id": <number>, "ok": true, "result": <any> }`
  - Failure: `{ "id": <number>, "ok": false, "error": { "code": <string>, "message": <string>, "data"?: <any> } }`
- **Server→client push (progress + events):** WebSocket at `GET /ws`.
  - Frames are JSON: `{ "event": <string>, "data": <any> }`
  - Events: `clone.progress`, `fetch.progress`, `push.progress`, `pull.progress`
    each with `{ phase: string, value: number /*0..100*/ , detail?: string }`.
- **Discovery:** `GET /health` → `{ "ok": true, "version": <string> }`.
  `GET /info` → `{ "name": "…", "version": "…", "port": <number> }`.
- **CORS:** server allows any origin (local dev). Bind to `127.0.0.1` by default.
- **Port:** default `4789`; override with env `GITDAEMON_PORT`. The server writes a
  discovery file `~/.gitdaemon/server.json` = `{ "url": "http://127.0.0.1:<port>" }`
  on start (best-effort; client may just default to `http://127.0.0.1:4789`).
- **Errors** use these `code` values: `bad_request` (malformed/unknown method),
  `not_found` (repo/ref missing), `git_error` (git command failed; `data.stderr`
  carries git's stderr, `data.args` carries the argv), `io_error`, `conflict`.

All paths sent by the client are **absolute server-side paths**. The server treats
them as trusted (local single-user daemon).

---

## Git execution model (server)

Mirror the current TS engine. Every git call:

- Runs `git -C <path> <args>` as a subprocess (use the `git` on `PATH`).
- Env layering (low→high precedence), applied to every call:
  - `TERM=dumb`
  - `GIT_TERMINAL_PROMPT=0`
  - `GIT_ASKPASS=` (empty) for credential/prompts → `envForAuthentication`
  - inherit the rest of the parent env.
- Capture stdout/stderr; treat exit code `0` as success unless a caller opts into
  other success codes. On failure produce a `git_error` with `stderr`, `args`.
- Prefer `-z`/NUL-delimited and `--format=` machine-readable output for parsing.

---

## Data types (JSON shapes)

Field names are **camelCase**. Unions are discriminated by a `kind` string.

```
Repository        = { id: string, path: string, alias: string | null, missing: boolean }
                   # id = server-computed stable hash of path (e.g. blake3/sha1 hex, or the path itself). Keep stable across runs.

RepositoryType    = { kind: "regular",  topLevelWorkingDirectory: string, gitDir: string }
                   | { kind: "bare",    gitDir: string }
                   | { kind: "missing" }
                   | { kind: "unsafe",  path: string }

AppFileStatus     = { kind: "new" }
                   | { kind: "modified" }
                   | { kind: "deleted" }
                   | { kind: "renamed",   oldPath: string }
                   | { kind: "copied",    oldPath: string }
                   | { kind: "conflicted", conflictedEntry: { kind: "conflicted" } }
                   | { kind: "untracked" }
                   # (conflict-marker/manual variants may be folded into "conflicted" for v1)

SubmoduleStatus?  = { commitChanged?: boolean, modifiedChanges?: boolean, untrackedChanges?: boolean }

FileChange        = { id: string, path: string, status: AppFileStatus, submoduleStatus?: SubmoduleStatus | null }
                   # id = path (matches legacy). For renames, path is the new path.

WorkingDirectoryStatus = { files: FileChange[], includeAll: boolean | null }

AheadBehind       = { ahead: number, behind: number }

IStatusResult     = {
  currentBranch: string | null,
  currentUpstreamBranch: string | null,
  currentTip: string | null,
  branchAheadBehind: AheadBehind | null,
  exists: boolean,
  mergeHeadFound: boolean,
  squashMsgFound: boolean,
  isCherryPickingHeadFound: boolean,
  workingDirectory: WorkingDirectoryStatus,
  doConflictedFilesExist: boolean,
}

Branch            = { name: string, ref: string, upstream: string | null, tip: { sha: string }, type: "local" | "remote" }
Remote            = { name: string, url: string }
CommitIdentity    = { name: string, email: string, date: string /*ISO-8601*/, tzOffset: number /*minutes*/ }
Commit            = { sha: string, shortSha: string, summary: string, body: string,
                     author: CommitIdentity, committer: CommitIdentity,
                     parentSHAs: string[], tags: string[] }
CommitOneLine     = { sha: string, summary: string }
StashEntry        = { name: string, branchName: string, stashSha: string }

DiffLine          = { type: "context" | "add" | "delete" | "hunk", text: string,
                     oldLineNumber: number | null, newLineNumber: number | null }
Hunk              = { header: string, oldStartLine: number, oldLineCount: number,
                     newStartLine: number, newLineCount: number, lines: DiffLine[] }
TextDiff          = { kind: "text", text: string, hunks: Hunk[], lineEndingsChange?: string | null }
LargeTextDiff     = { kind: "largeText", text: string }
ImageData         = { contents: string /*base64*/, mediaType: string, bytes: number }
ImageDiff         = { kind: "image", previous: ImageData | null, current: ImageData | null }
BinaryDiff        = { kind: "binary" }
SubmoduleDiff     = { kind: "submodule", fullPath: string, url: string | null, status: string, oldSHA: string, newSHA: string }
UnrenderableDiff  = { kind: "unrenderable", reason: string | null }
Diff              = TextDiff | LargeTextDiff | ImageDiff | BinaryDiff | SubmoduleDiff | UnrenderableDiff

ChangedFilesResult= { files: FileChange[], linesAdded: number, linesDeleted: number }
AuthorIdentity    = CommitIdentity | null
```

---

## Methods

Every method takes `params` (object) and returns `result`. `path` means the repo
working-tree path (or git dir for bare). Numbers default as noted.

### Repository
- `repo.list` → `Repository[]`  (from server store, newest-last; include `missing:true` if path vanished)
- `repo.open` `{ path, alias? }` → `Repository`  (validate git repo via type; register in store)
- `repo.close` `{ path }` → `{}`
- `repo.type` `{ path }` → `RepositoryType`
- `repo.setAlias` `{ path, alias }` → `Repository`
- `repo.init` `{ path }` → `Repository`  (`git init`, default branch main)

### Status / staging
- `status.get` `{ path, includeUntracked? = true }` → `IStatusResult`
- `status.stage` `{ path, files: string[] }` → `{}`  (`git add -- <files>`; conflicted files handled)
- `status.unstage` `{ path, files: string[] }` → `{}`  (`git reset -q -- <files>`)
- `status.unstageAll` `{ path }` → `{}`
- `status.discard` `{ path, files: string[], includeUntracked? = true, moveToTrash? = false }` → `{}`
  (tracked: `git checkout -- <files>`; untracked: delete from disk or move to trash)

### Diffs
- `diff.workingDirectory` `{ path, file: { path, status }, hideWhitespace? = false }` → `Diff`
- `diff.commit` `{ path, file: { path }, commitish }` → `Diff`
- `diff.stash` `{ path, stashSha, file: { path } }` → `Diff`  (diff of a file in a stash entry)
- `image.workingDirectory` `{ path, file }` → `ImageDiff`  (fast path used by client for images)

### Commits / history
- `commit.create` `{ path, message: { summary, description }, files?: string[], amend? = false, allowEmpty? = false }` → `{ sha: string }`
  (stage `files` if provided, else commit the index as-is; write message via stdin/`-F -`)
- `log.list` `{ path, revisionRange?, limit? = 100, skip? = 0 }` → `Commit[]`
- `log.oneLine` `{ path, revisionRange?, limit? = 100 }` → `CommitOneLine[]`
- `log.commit` `{ path, ref }` → `Commit | null`
- `log.changedFiles` `{ path, sha }` → `ChangedFilesResult`
- `commit.undo` `{ path, sha }` → `{}`  (`git revert --no-edit <sha>`)
- `commit.resetTo` `{ path, sha, mode: "soft" | "mixed" | "hard" }` → `{}`

### Branches
- `branch.list` `{ path }` → `Branch[]`  (local + remote)
- `branch.create` `{ path, name, startPoint?: string | null, noTrack? = false }` → `{}`
- `branch.rename` `{ path, name, newName }` → `{}`
- `branch.delete` `{ path, branch: { name, type } }` → `{}`  (local → `git branch -D`; remote → push --delete)
- `branch.checkout` `{ path, name }` → `{}`
- `commit.checkout` `{ path, sha }` → `{}`  (detached)
- `branch.aheadBehind` `{ path, branch: { name, upstream } }` → `AheadBehind`

### Remotes
- `remote.list` `{ path }` → `Remote[]`
- `remote.add` `{ path, name, url }` → `{}`
- `remote.remove` `{ path, name }` → `{}`
- `remote.setUrl` `{ path, name, url }` → `{}`

### Tags
- `tag.list` `{ path }` → `{ [name: string]: string /*sha*/ }`
- `tag.create` `{ path, name, targetCommitSha }` → `{}`  (annotated; `-m <name>`)
- `tag.delete` `{ path, name }` → `{}`

### Stash  (uses marker message prefix `!!GitHub_Desktop` to identify desktop stashes)
- `stash.list` `{ path }` → `StashEntry[]`
- `stash.create` `{ path, branchName, includeUntracked? = true }` → `{}`
- `stash.pop` `{ path, stashSha }` → `{}`
- `stash.drop` `{ path, stashSha }` → `{}`

### Config / identity
- `config.getValue` `{ path?, name, onlyLocal? = false }` → `string | null`
- `config.setValue` `{ path?, name, value, onlyLocal? = false }` → `{}`
- `config.author` `{ path }` → `AuthorIdentity`  (`git var GIT_AUTHOR_IDENT`, parse name/email/date)

### Network  (emit progress on the matching `/ws` event; still return final result)
- `fetch` `{ path, remote?, pruneBackground? }` → `{}`  (`git fetch --prune` or `--all` if remote omitted)
- `pull` `{ path, remote }` → `{}`  (`git pull`)
- `push` `{ path, remote, localBranch, remoteBranch?: string | null, tagsToPush?: string[], forceWithLease? = false }` → `{}`
- `clone` `{ url, path, options?: { branch?, defaultBranch? } }` → `Repository`  (register in store on success)

---

## Client behavior

- Resolve the server base URL: `?server=` query param → `window.GITDAEMON_URL` →
  `localStorage.gitdaemon_url` → `http://127.0.0.1:4789`.
- Trigger operations by `POST /rpc`. Show spinner/disabled state while in flight.
- Subscribe to `GET /ws` to render progress bars for clone/fetch/push/pull.
- On any git operation that mutates a repo, the client re-issues `status.get`,
  `log.list`, `branch.list` to refresh (simple polling-after-mutation; no state sync needed in v1).
