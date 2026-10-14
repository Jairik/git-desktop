# GitDaemon Desktop

An **Electron thin shell** for the gitdaemon product. It does **not** reimplement
any UI: it starts the existing Rust `gitdaemon`, waits for its `/health`
endpoint, then points a single `BrowserWindow` at it. The web client you see in
the window is the _same_ React bundle a browser loads — no duplicated UI.

```
Electron (desktop/)  ──spawns──▶  gitdaemon (server/, Rust)
       │                                │  serves client/dist SPA when
       │  BrowserWindow ───────────────▶│  GITDAEMON_SERVE_DIR is set
       ▼                                ▼  + `GET /rpc` API + `GET /ws`
  http://127.0.0.1:<free-port>/*
```

## How servicing works

The daemon binds a single loopback port and, when its `GITDAEMON_SERVE_DIR`
env is set, serves the built SPA from it (unknown paths fall back to
`index.html`). The API (`POST /rpc`, `GET /ws`, `GET /health`) lives on that
same origin. So the desktop window and the API share one origin, and the client
is byte-for-byte identical to the browser client.

The shell picks a **fresh free loopback port** (not the client's `:4789`
default), starts the daemon on it, waits for `GET /health` → `{ "ok": true }`
(up to ~10s), then loads `http://127.0.0.1:<port>/`. It injects the chosen
backend into the client via the `?server=` query param (the client's top-priority
resolution channel) and, best-effort, `window.GITDAEMON_URL` from the preload —
otherwise the client would ignore the random port and default to `:4789`.

## Prerequisites

Install the **root** dependencies first. `electron` is a root `devDependency`
(`electron@44.x`), not a desktop dependency — the shell reuses it. From the repo
root:

```sh
yarn install
# sanity check that electron resolved from the root:
node -e "console.log(require.resolve('electron'))"
```

> `node_modules` must exist at the repo root. The `desktop/` package has no
> dependencies of its own and expects to be run from inside the monorepo.

Build the daemon server and the web client (the shell loads whatever is built):

```sh
yarn daemon:release      # server: cargo build --release  → server/target/release/gitdaemon
yarn web:build           # client: cd client && npm run build → client/dist
```

The shell looks for the daemon binary at, in order: `$GITDAEMON_BIN`,
`server/target/release/gitdaemon`, then `server/target/debug/gitdaemon`. If none
is present it shows a dialog with the exact build command (`yarn daemon:release`)
and quits gracefully.

If `client/dist` is missing, the daemon still starts (API-only) and the window
shows a friendly page asking you to run `yarn web:build`.

## Running

```sh
cd desktop
npm start        # electron .
```

(`npm run dev` is an alias for `npm start`.) The repo root provides aliases:
`yarn desktop` (= `cd desktop && npm start`), `yarn desktop:check`, and
`yarn desktop:smoke` (runs the no-Electron logic smoke test).

The app uses a single-instance lock and, on quit (`before-quit`), sends SIGTERM
to the daemon **only if the shell spawned it**. If the daemon exits unexpectedly
a dialog is shown.

## Environment variables

| Variable            | Effect                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `GITDAEMON_URL`     | **Don't spawn** a daemon; load this existing backend instead (dev / remote use). |
| `GITDAEMON_BIN`     | Override the daemon binary path (defaults to release, then debug build).          |
| `VITE_DEV_SERVER_URL` | Load the Vite dev server for the UI; the spawned daemon provides the API.       |

The spawned daemon always receives `GITDAEMON_PORT=<free port>` and, when the
client is built, `GITDAEMON_SERVE_DIR=<abs path to client/dist>`.

## Security

- `contextIsolation: true`, `nodeIntegration: false`.
- The preload exposes only a tiny read-only bridge, `window.gitdesktop`
  (`platform` + `versions` from `process.versions`). No `node`/`fs`/`ipc` object
  reaches the renderer.

## Files

```
desktop/
├── package.json            # name "gitdesktop-desktop", private, type commonjs
├── main.js                 # bootstrap + exported pure helpers (port/spawn/health)
├── preload.js              # contextBridge: window.gitdesktop (+ injects GITDAEMON_URL)
├── README.md
└── scripts/
    └── smoke-spawn.js      # logic smoke test (no Electron): port→spawn→/health→fetch
```

## Verification

```sh
# static checks
node --check desktop/main.js && node --check desktop/preload.js
# (or) cd desktop && npm run check

# logic smoke test without Electron — reuses main.js's port-pick/spawn/health
# helpers; uses the real gitdaemon binary if built, else a tiny stand-in server
node desktop/scripts/smoke-spawn.js
node desktop/scripts/smoke-spawn.js --standin   # force the stand-in
```

## Roadmap

- `electron-packager` / `electron-builder` for distributable, code-signed bundles.
- Package the `gitdaemon` binary alongside the app (or build/locate it at runtime).
- Native menu items for the repo-authoring actions once the client exposes them.
