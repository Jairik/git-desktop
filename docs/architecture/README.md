# Architecture — local server-client client

This fork has been condensed into a **minimal, well-documented server-client
Git client**. It keeps the git engine a git engine and adds a small, explicit
boundary so the product is easy to build on. GitHub support is thin and optional
(surfaced via the `gh` CLI — Pull Requests and CI checks); the deep GitHub
integrations were dropped, so pure-local Git works fully offline. Optional local
AI agents (the `opencode`/`claude`/`codex`/`cursor-agent` CLIs) add commit-message
generation, file comments and reviews. The same React client runs in the browser
and inside a thin Electron shell.

```
┌────────────────────────┐         JSON-RPC (POST /rpc)          ┌──────────────────────────┐
│  React web client      │  ───────────────────────────────────▶ │  gitdaemon (Rust/axum)   │
│  client/  (Vite+React) │  ◀─────────────────────────────────── │  server/                 │
│                        │         {ok,result} / {ok,error}      │  • HTTP router + dispatch│
│  Changes / History /   │                                       │  • GitRunner (git CLI)   │
│  Branches / Remotes /  │  ◀════════ WebSocket /ws ══════════▶   │  • repository store      │
│  Stash / Tags          │       progress: clone/fetch/push/pull  │  • 53 RPC methods        │
└────────────────────────┘                                       └────────────┬─────────────┘
        thin client                                                          │ subprocess
                                                                             ▼
                                                                     `git -C <repo> ...`
```

## Layout

| Path | What | Stack |
|------|------|-------|
| [`server/`](../../server) | `gitdaemon` — the local backend. Git engine + JSON-RPC API + repo store. | Rust, axum, tokio (shells out to the `git` CLI) |
| `client/` | The React web client. A thin client; every op is an RPC call. | React 18 + TypeScript + Vite |
| `desktop/` | Thin **Electron shell**: spawns the daemon and serves `client/dist`. Reuses the web UI — no duplicated code. | Node / Electron |
| [`../BUILD.md`](../BUILD.md) | Build & run reference for server, client, and desktop. | — |
| [`server-client.md`](server-client.md) | The authoritative wire contract (transport, methods, JSON shapes). | — |
| [`scripts/e2e-smoke.sh`](scripts/e2e-smoke.sh) | End-to-end regression test (`yarn e2e`). | bash |

## Running

Two processes, both local.

```sh
# 1. Backend daemon (default http://127.0.0.1:4789; override with GITDAEMON_PORT)
yarn daemon            # == cd server && cargo run

# 2. Frontend (default connects to http://127.0.0.1:4789)
yarn web               # == cd client && npm install && npm run dev
```

Point the client elsewhere with `?server=http://host:port`, the
`window.GITDAEMON_URL` global, or `localStorage.gitdaemon_url`. If the daemon is
down the client shows a "Cannot reach the git server" banner — nothing blocks.

Utility scripts at the repo root: `yarn daemon:build`, `yarn daemon:release`,
`yarn web:typecheck`, `yarn e2e`.

The Pull Requests and Checks/CI views need the `gh` CLI installed and logged in
(`gh auth login`) on the machine running the daemon; otherwise the client shows
setup steps instead.

### One binary, or the desktop shell

`yarn build` (release daemon + client) then `yarn serve` serves the UI *and* the
API from a single `gitdaemon`; open <http://127.0.0.1:4789/>. Or run the Electron
desktop shell with `yarn desktop` (it spawns the daemon and opens the same UI in a
window). Local AI agents are auto-detected from `PATH` and configured in the
**Agents** tab (see `server/agents.toml`). Full details in
[`../BUILD.md`](../BUILD.md).

## Design principles (why it's shaped this way)

- **Minimal + explicit.** One transport (`POST /rpc`), one push channel
  (`GET /ws`), one dispatch table. There is no framework magic to learn.
- **The engine stays a git engine.** The daemon runs the real `git` CLI behind a
  single `GitRunner` (with the same env layering the legacy app used:
  `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`). This keeps behavior
  faithful and lets every git capability stay reachable. libgit2 is a possible
  future optimization for read-heavy paths, but is not required.
- **Thin client.** The React client holds no git logic; it renders results and
  re-fetches after mutations (per the contract's client-behavior rules).
- **Thin shells over external CLIs.** The daemon shells out to `git`, `gh`, and the
  AI agent CLIs; it reimplements none of them. Adding a capability is usually one
  subprocess wrapper, not a new dependency.
- **Easy to extend.** Adding capability is mechanical and localized — see below.
- **Decoupled.** The client never imports the legacy `app/` bundle, and the two
  halves can evolve independently as long as they honor the contract.

## How to add a new operation

Two small edits plus one optional UI edit — all follow the existing pattern.

1. **Contract first.** Add the method to
   [`server-client.md`](server-client.md) (name, params, result shape). Both
   sides read this file.
2. **Server.** Add a `git::*` helper in the right `server/src/git/*.rs` module,
   register a handler in `server/src/handlers/*.rs`, and add one line to the
   dispatch match in `server/src/rpc.rs`. (`GitRunner` handles env + error
   mapping for you.)
3. **Client.** Add a typed wrapper to the `methods` map in
   `client/src/api/client.ts` and the wire types to `client/src/api/types.ts`.
4. **UI (optional).** Call it from a store action (use `runMutation(...)` so data
   refreshes) or render it in a `client/src/ui/*Tab.tsx` view.

The 53 existing methods in `server/src/rpc.rs` are the reference pattern — copy
the closest one.

## What's covered

The complete **local Git workflow**: open/create/clone a repo; working-tree
status with per-file stage/unstage/discard; text/image/binary diffs; commit
(with amend/empty); history with per-commit file diffs, undo (revert) and reset;
branches (list/create/rename/checkout/delete local+remote, ahead/behind);
remotes CRUD; tags CRUD; stash; config + author identity; and network ops
fetch/pull/push/clone with live progress over WebSocket. When the `gh` CLI is
installed and authenticated on the server machine, it also lists Pull Requests and
per-branch CI checks. Auto-detected local AI agents (`agent.*` methods) generate
commit messages, summarize/review files, commits and PRs, and reply to per-file
comments. The same client runs in the browser and in a thin Electron shell
(`desktop/`). See the full method list
in the contract.

## Not (yet) implemented — and where it lives in the legacy code

This MVP intentionally parks the following. The legacy TypeScript references are
given so future work knows exactly what to port behind a new contract method:

- **GitHub platform (deep)** — beyond the `gh`-backed PR list/view/checkout and CI
  checks now implemented, these stay out of scope: in-app account auth, PR
  review/comment UI, the forks flow, secret scanning, Copilot: legacy
  `app/src/lib/api`, `lib/ci-checks`, `stores/pull-request-store`,
  `stores/accounts-store`.
- **Advanced history ops UI** — interactive rebase, squash, reorder, cherry-pick:
  legacy `app/src/lib/git/{rebase,squash,reorder,cherry-pick,merge-tree}.ts`. The
  daemon already has `commit.undo`/`commit.resetTo`; conflict-driven multi-commit
  flows would be the next layer.
- **Merge** — legacy `app/src/lib/git/merge.ts` (fast-forward merges can reuse
  `branch.checkout` + `fetch`).
- **LFS** — legacy `app/src/lib/git/lfs.ts`.
- **Submodules** — legacy `app/src/lib/git/submodule.ts`.
- **Worktrees** — legacy `app/src/lib/git/worktree.ts`.
- **Partial-line staging** (select specific hunks/lines) — legacy
  `applyPatchToIndex` / `discardChangesFromSelection` in `app/src/lib/git/diff.ts`;
  the contract reserves room (`discardChangesFromSelection`).
- **OS integration** — external editors, shells, desktop notifications, keychain,
  auto-update: legacy `lib/editors`, `lib/shells`, `lib/notifications`,
  `stores/token-store`. These need a host integration point on the daemon side.
- **Tutorial / blank-slate onboarding**, telemetry/stats, crash reporting.
- **Agent depth** — streaming/token-level agent output, agent run history, and
  multi-file / agent-scoped tasks (the generic per-task config is the seam).
- **Desktop packaging** — app icons, code-signing/notarization, auto-update, and
  electron-builder config for `.dmg`/`.AppImage`/`.exe` (the shell runs today via
  `yarn desktop`).

## Verifying

```sh
yarn e2e                       # builds the daemon and drives the full workflow over HTTP
cd server && cargo build        # backend compiles
cd client && npm run typecheck  # client type-checks against the contract
cd client && npm run build      # client production build
```
