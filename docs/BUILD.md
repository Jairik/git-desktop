# Build & run reference

One place for how to build and run every part of this fork:

| Part | What it is | Language |
| --- | --- | --- |
| `server/` | `gitdaemon` — the local backend (git + gh + agents) | Rust / axum |
| `client/` | the web client (also what the desktop shell renders) | Vite + React |
| `desktop/` | a thin **Electron shell** that spawns the daemon + serves the client | Node / Electron |

Both the web client and the desktop app talk to the **same daemon** over
`POST /rpc` + `GET /ws`. When `GITDAEMON_SERVE_DIR` is set, the daemon *also*
serves the built client as a single-page app, so one binary powers both the
browser UI and the desktop window (same URL, same code).

## Prerequisites

- **Rust** (edition 2021; recent stable). `rustc --version`.
- **Node** — the repo pins a version in `.nvmrc` (`nvm install && nvm use`, or any Node 20+).
- **Yarn 1.x** — this repo *vendors* it and many machines have no global `yarn`.
  Use `node vendor/yarn-1.21.1.js <script>` anywhere you see `yarn <script>`.
- **Optional — agents:** the auto-detected AI CLIs (`opencode`, `claude`, `codex`, `cursor-agent`).
- **Optional — PRs/CI:** the GitHub CLI `gh`, authenticated (`gh auth login`).

## Build everything

```sh
yarn build            # = build:server (cargo --release) + build:client (vite build)
```

Produces `server/target/release/gitdaemon` and `client/dist/`.

## Build the pieces

| Task | Command | Output |
| --- | --- | --- |
| Server (release) | `yarn build:server` | `server/target/release/gitdaemon` |
| Server (debug) | `yarn daemon:build` | `server/target/debug/gitdaemon` |
| Web client | `yarn build:client` (aka `yarn web:build`) | `client/dist/` |
| Client type-check | `yarn web:typecheck` | (`tsc --noEmit`) |
| Desktop checks | `yarn desktop:check` + `yarn desktop:smoke` | syntax + daemon-serve logic |

## Run it

### Web client in a browser — one binary serves the UI + API

```sh
yarn build            # once
yarn serve            # daemon serves client/dist + API on http://127.0.0.1:4789/
```

Open <http://127.0.0.1:4789/>. `yarn serve:dev` uses the debug binary. Choose a
port with `GITDAEMON_PORT=<port>`.

### Classic dev loop (HMR) — Vite dev server + separate daemon

```sh
yarn daemon           # API-only daemon on :4789
yarn web             # Vite dev server (HMR); it connects to the daemon automatically
```

The client finds the daemon via `?server=` → `window.GITDAEMON_URL` →
`localStorage.gitdaemon_url` → `http://127.0.0.1:4789`.

### Desktop app (Electron shell)

Electron is a **root devDependency**; if the root `node_modules/` is absent,
install it first (heavy): `node vendor/yarn-1.21.1.js install`. Then:

```sh
yarn build            # build the server (release) + client (dist) the shell reuses
yarn desktop          # == cd desktop && npm start  (electron .)
```

The shell spawns `server/target/release/gitdaemon` (falls back to the debug
binary), serves `client/dist` via `GITDAEMON_SERVE_DIR`, waits for `/health`, and
opens a window on the SPA URL. Env knobs: `GITDAEMON_BIN` (custom daemon path),
`GITDAEMON_URL` (reuse a running daemon instead of spawning one),
`VITE_DEV_SERVER_URL` (load the Vite dev server during UI work).

## Agents (commit messages, reviews, summaries)

The daemon shells out to whatever AI CLIs are on your `PATH` (no SDKs bundled).
The documented default config is **`server/agents.toml`** — edit it, or use the
in-app **Agents** tab (which persists overrides under the daemon data dir,
`~/.gitdaemon`). `commit_message` ships wired to the `generate-commit-message`
skill (`server/skills/generate-commit-message/SKILL.md`).

Env: `GITDAEMON_AGENTS_CONFIG` (alt config path), `GITDAEMON_SKILLS_DIR` (extra
skills), `GITDAEMON_AGENT_TIMEOUT_SECS` (default 240).

## Tests / regression

- **End-to-end smoke** (builds the daemon, drives the whole workflow — repo,
  stage, commit, branch, diff, GitHub + agent status): `yarn e2e`.
- **Agent + SPA regression** (deterministic fake agent: `agent.*`, `comment.*`,
  and `GITDAEMON_SERVE_DIR`): `yarn e2e:agents`.
- **Rust checks:** `cd server && cargo build && cargo clippy -- -W clippy::all`.
- **Client checks:** `yarn web:typecheck && yarn web:build`.

## Troubleshooting

- **Port in use:** `GITDAEMON_PORT=4788 yarn serve`.
- **"client/dist not found":** run `yarn build:client` (browser) / `yarn build` (serve + desktop).
- **"gitdaemon not found" in the desktop shell:** run `yarn build:server`.
- **Electron won't launch:** make sure the root deps (Electron) are installed — see the Yarn note above.
