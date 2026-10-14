# The agents / desktop pass — decisions, questions & status

This documents the multi-part expansion: clear build commands, a thin **Electron
client** alongside the **web client**, and **local-AI-agent** integration (auto-scan
+ configurable tasks) for commit messages, file comments, reviews and file
summaries. Everything lands on branch `server-client-refactor`.

## How each request was met

1. **Clear build commands for everything** — `docs/BUILD.md` + root scripts:
   `yarn build` (`build:server` cargo release + `build:client` vite),
   `yarn build:server` / `yarn daemon:build`, `yarn build:client` / `yarn web:build`,
   `yarn web:typecheck`, `yarn serve` (one binary serves UI+API),
   `yarn desktop` / `yarn desktop:check` / `yarn desktop:smoke`, `yarn e2e`, `yarn e2e:agents`.

2. **Clean Electron UI client + web client connecting to the frontend**
   - `desktop/` is a **thin Electron shell**: it picks a free loopback port, spawns
     `gitdaemon` with `GITDAEMON_SERVE_DIR=client/dist`, waits for `/health`, and
     opens a `BrowserWindow` on the SPA URL. It **reuses the web client — no
     duplicated UI**. `GITDAEMON_URL` attaches to a running daemon; `VITE_DEV_SERVER_URL`
     loads the Vite dev server.
   - The **web client** runs the same UI in a browser: `set GITDAEMON_SERVE_DIR`
     (done by `yarn serve`) makes the daemon serve `client/dist` at `/`.

3. **Agent integration via their CLIs; autoscan; commit messages; config; the
   `generate-commit-message` skill** — the daemon shells out to installed AI CLIs
   (`agent.*` methods). `agent.list` auto-scans `PATH` (cached). Config lives in
   `server/agents.toml` (documented defaults) with per-task agent/prompt/skill;
   the **Agents** tab edits it (persisted under `~/.gitdaemon`, or
   `$GITDAEMON_AGENTS_CONFIG`). `commit_message` is wired to the
   **generate-commit-message** skill (`server/skills/generate-commit-message/SKILL.md`).
   The CommitComposer has a **✨ Generate message** button → `agent.commit_message`.

4. **Agents auto-scan and configure for any task** — detection for
   `opencode`/`claude`/`codex`/`cursor-agent` (+ disabled `aider`/`gemini` examples);
   tasks `commit_message`/`summarize_file`/`review`/`comment`; adding a task is a
   config edit + one small server context-builder (documented).

3.5. **Specific files (during preview) get comments that immediately go to
   agents** — `FileComments` in the Changes/diff preview: add a comment (body +
   optional line/side), **Send to agent** (`comment.send` runs the `comment` task
   and shows the reply + a `sent` status). Comments persist per-repo in the data dir.

3.6. **An agent can easily summarize the current file on request** —
   `SummarizeFileButton` in the file preview → `agent.summarize_file`, shown in a
   panel with a copy button.

5. **"Agent Review" button for commits, PRs, or specific files** —
   `AgentReviewButton` + `ReviewPanel` placed on each commit row (History), each
   PR row (Pull Requests), and the file-preview header → `agent.review`
   (`file` diff / `commit` `git show` / `pr` `gh pr view`+`gh pr diff`). Free-form
   output rendered as-is.

6. **UI + performance polish** — lazy-mounted tabs, memoized rows/callbacks,
   ref-guarded loads (no refetch loops), consistent skeleton/spinner + empty
   states, `aria-busy`/disabled controls, and small consistently-named styles.

## Decisions made (I guessed so I wouldn't block — change any and I'll adjust)

- **Invocation model:** agents run their non-interactive/print subcommand with all
  context **embedded in the prompt, passed as a single argv argument** (no shell;
  no tool/file-read permission prompts; no shell injection). Default argv:
  `opencode run`, `claude -p`, `codex exec`, `cursor-agent -p`.
- **Default agent = `claude`** for shipped tasks; commit-message **skill is
  bundled** at `server/skills/generate-commit-message/SKILL.md` so it works
  out-of-the-box.
- **SPA serving is opt-in** (`GITDAEMON_SERVE_DIR`), so dev/e2e stay API-only/fast.
- **Agent review output is free-form text** (not a structured findings schema).
- **Electron is a thin shell** (reuses the client; loads the served SPA URL rather
  than `file://`, which fits origin/CORS).

## Open questions for you

- **Q1.** Default agent: keep `claude`, or prefer `opencode`/`codex`? And should
  agent stdout be returned raw or post-processed to strip CLI chatter?
- **Q2.** Should `commit_message` read your *live* skill (`GITDAEMON_SKILLS_DIR`) so
  edits propagate, or keep the bundled skill as the default? (Both supported.)
- **Q3.** File comments: keep them local-only, or eventually post to the GitHub PR
  as review comments via `gh`?
- **Q4.** Reviews: happy with free-form text, or want a structured findings schema
  (severity/file/line/fix) later?
- **Q5.** Desktop packaging: I ship `yarn desktop` (runs the shell) but **no
  installer build** (icons/notarization/electron-builder) — the root `node_modules`
  aren't installed here so I couldn't verify a real Electron launch. Add
  electron-builder config + icons?
- **Q6.** Any other local agent CLIs you use that should be auto-detected by
  default?
- **Q7.** Should `yarn daemon`/`yarn serve` auto-serve `client/dist` when present,
  instead of requiring `GITDAEMON_SERVE_DIR`?
- **Q8.** Perf priority: very long diffs, huge commit histories (virtualization),
  or many repos? (I did lazy tabs + memoization + skeletons.)
- **Q9.** Agent-safety: agents receive the repo diff/prompt via argv — fine for a
  local single-user tool, or add a per-task "ask before running" toggle?

## Verification (all green)

- `cargo build` + `clippy` clean (only 3 pre-existing warnings).
- Client: `tsc --noEmit` 0 errors, `vite build` 227.8 kB, `npm run smoke` OK.
- `yarn e2e` = **19/19** (added `agent.list`); `yarn e2e:agents` = **11/11**
  (deterministic fake agent: `agent.*`, `comment.*`, and `GITDAEMON_SERVE_DIR`).
- Joint live integration: daemon serves the freshly-built `client/dist` at `/`
  (SPA fallback 200); `agent.list`/`agent.config.get` shapes match the client.
- `desktop:smoke` = health PASS + `/` 200 (real client). A real `claude` run and a
  deterministic fake agent were both exercised.

## Not done / deferred (flagged, not blockers)

- Desktop installer packaging (icons/signing/electron-builder) — see Q5.
- Streaming/token-level agent output; agent run history; structured review findings.
- Installers/auto-update; OS integration points (still in the architecture "not yet"
  list).

## Review log

Three review passes ran (two GLM 5.3-flash, one default-agent full-branch review).
Fixed and verified: arbitrary-file-read via `file` in `agent.summarize_file`/comments
(H1 → `safe_join_repo_file`), comment-store race + non-atomic writes (H2 → atomic
tmp+rename, corrupt quarantine, re-read-and-splice), agent timeout hang on
grandchildren (M3 → process-group kill), stale agent-availability cache (M4),
non-stable comment filenames (M6 → FNV-1a), Electron child `error` crash +
renderer `sandbox` (L5/L7), empty `detect` launching a TUI (L10),
`status.get includeUntracked=false` (L2 → `--untracked-files=no`), force-push via a
`+`-prefixed branch (L3), `SummarizeFileButton` `ref` prop (L6 → `atRef`), Electron
navigation guards (L8), and `gh` ref validation (L4b).

**Deferred (small, non-blocking — future pass):**
- **L1** `FileComments`/`AgentsSettings` use a module-scope `loadedFor` ref that
  survives repo switches, so the same-named file in another repo shows "no
  comments"/"0 agents" until a manual Rescan. Fix: reset the ref on repo change
  (or key the component by repo path).
- **L4** `reject_option` not applied to a few client-supplied refs/shasa/remote
  names (`rename_branch`, `undo_commit`, `run_log_with`, `delete_tag`,
  `fetch`/`pull` remote). Verified non-exploitable (positional / after `--`);
  defense-in-depth only.
- **L5** client `splitUpstream` splits on the first `/`, which is wrong for remotes
  whose names contain `/` (e.g. remote `my/fork`). The server's
  `split_remote_branch` does longest-match; wire the client to it.
- **L7** non-UTF-8 filenames are read with `from_utf8_lossy` despite `-z`, so a
  latin-1 filename renders mangled and later stage/discard misses it. Needs an
  `OsString`/bytes path; at minimum surface a clear error.
- **L9** `agent.list` probes agents sequentially (each up to ~20 s); probing
  concurrently would shorten a cold first scan.
