# Decisions & open questions — the agents / desktop pass

This pass adds: clear build commands, a thin Electron client alongside the web
client, and local-AI-agent integration (auto-scan + configurable tasks) for
commit messages, file comments, reviews, and file summaries.

Below are the **assumptions I made** (so I could move fast without blocking), and
the **open questions** for you. I've guessed reasonable defaults for each; change
any of them and I'll adjust.

## Decisions made (guess-able defaults)

1. **Agent invocation model.** Agents are driven by their *non-interactive /
   print* subcommand, with all context (diff / file / commit / PR) **embedded in
   the prompt and passed as a single argv argument** (never a shell string), so
   no tool or file-read permission prompts are needed and there's no shell
   injection. Default argv: `opencode run`, `claude -p`, `codex exec`,
   `cursor-agent -p`.
2. **`commit_message` uses the `generate-commit-message` skill.** Bundled at
   `server/skills/generate-commit-message/SKILL.md` and referenced from
   `server/agents.toml`, so it works out of the box. Config (agents + per-task
   agent/prompt/skill) lives in `server/agents.toml`; overrides persist to
   `~/.gitdaemon` (data dir) or `$GITDAEMON_AGENTS_CONFIG`.
3. **Default agent = `claude`** for the shipped tasks (closest to pure text-out).
   Everything is switchable in the app's **Agents** tab.
4. **Electron reuses the web client** — it spawns `gitdaemon` with
   `GITDAEMON_SERVE_DIR=client/dist` and loads the SPA URL. No duplicated UI.
   (Rejected `file://` loading: opaque origin + loopback-CORS is a poor fit.)
5. **One-binary web mode.** `GITDAEMON_SERVE_DIR` makes the daemon serve the built
   client; this stays **opt-in** so dev/e2e remain API-only and fast.
6. **Agent review output is free-form text** (not parsed into structured
   findings) — rendered as-is.

## Open questions for you

- **Q1 (agent default).** Should the default agent be `claude`, or would you
  prefer `opencode` / `codex`? (Real stdout sometimes includes extra chatter —
  should I post-process to strip it, or return raw?)
- **Q2 (skill source).** Should `commit_message` embed the bundled skill, or read
  your *live* Codex skill at runtime (`GITDAEMON_SKILLS_DIR`) so edits there
  propagate? Both are supported; which should be the default?
- **Q3 (comments scope).** Per-file comments live in the daemon data dir and go
  to an agent. Do you eventually want them posted to the GitHub PR as review
  comments (`gh`), or stay local-only?
- **Q4 (review shape).** Happy with raw-text `AgentReview.output`, or want a
  structured findings schema (severity / file / line / fix) parsed later?
- **Q5 (desktop packaging).** I ship `yarn desktop` (runs the shell) but **no
  installer build** (icons / notarization / electron-builder), because the root
  `node_modules` aren't installed here so I couldn't verify a real launch or
  packaging. Want me to add an `electron-builder` config + app icons?
- **Q6 (auto-scan list).** Auto-detected agents are `opencode`, `claude`,
  `codex`, `cursor-agent` (plus disabled `aider`/`gemini` examples). Any other
  local agent CLIs you use that should be detected by default?
- **Q7 (serving default).** Should `yarn daemon` serve `client/dist` automatically
  when it exists (convenience), instead of requiring `GITDAEMON_SERVE_DIR`?
- **Q8 (perf priorities).** For the UI/perf polish: which cases matter most — very
  long diffs, huge commit histories (virtualized lists?), or many repos? I did
  lazy tabs + memoization + empty/skeleton states.
- **Q9 (agent safety).** Agents receive the repo diff/prompt via argv. Fine for a
  local single-user tool, or do you want a per-task "ask before running an agent"
  confirmation toggle?
