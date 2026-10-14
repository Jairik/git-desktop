'use strict'

/**
 * gitdesktop — the Electron *thin shell* for the gitdaemon product.
 *
 * This process does NOT reimplement any UI. It starts the existing Rust
 * `gitdaemon` (or attaches to one behind `GITDAEMON_URL`), waits for its
 * `/health` endpoint, then points a single BrowserWindow at it. Because the
 * daemon serves the built React SPA when `GITDAEMON_SERVE_DIR` is set (unknown
 * paths fall back to `index.html`), the web client is byte-for-byte identical
 * in a browser and in the desktop app — no duplicated UI.
 *
 * The port-pick / spawn / health-poll / serve helpers below are pure Node and
 * are exported so `desktop/scripts/smoke-spawn.js` can exercise the same flow
 * without launching Electron. Electron itself is `require`d lazily inside
 * `launch()`, so this module loads fine under a plain `node` (and `node
 * --check`).
 */

const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const LOOPBACK_HOST = '127.0.0.1'
const HEALTH_PATH = '/health'
const HEALTH_TIMEOUT_MS = 10000
const HEALTH_INTERVAL_MS = 150

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

const repoRoot = () => path.resolve(__dirname, '..')

const daemonBinaryCandidates = () => [
  path.resolve(repoRoot(), 'server/target/release/gitdaemon'),
  path.resolve(repoRoot(), 'server/target/debug/gitdaemon'),
]

/**
 * Resolve the daemon binary to launch: `GITDAEMON_BIN` override first (when it
 * exists), else the release build, else the debug build. Returns an absolute
 * path or `null` when none exists.
 */
function resolveDaemonBinary() {
  const override = process.env.GITDAEMON_BIN
    ? path.resolve(process.env.GITDAEMON_BIN)
    : null
  if (override && fs.existsSync(override)) return override

  for (const candidate of daemonBinaryCandidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Absolute path to the built SPA (`client/dist`), or `null` if unbuilt. */
function resolveServeDir() {
  const dir = path.resolve(repoRoot(), 'client/dist')
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null
}

const daemonBaseUrl = port => `http://${LOOPBACK_HOST}:${port}`

/** Ambient env + the child daemon's contract env (`GITDAEMON_PORT`, …). */
function buildDaemonEnv({ port, serveDir }) {
  const env = { ...process.env, GITDAEMON_PORT: String(port) }
  if (serveDir) env.GITDAEMON_SERVE_DIR = serveDir
  return env
}

/* -------------------------------------------------------------------------- */
/* Free loopback port                                                         */
/* -------------------------------------------------------------------------- */

/** Bind `127.0.0.1:0`, read the assigned port, close, and return the number. */
function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, LOOPBACK_HOST, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Child process spawn + lifecycle                                            */
/* -------------------------------------------------------------------------- */

/**
 * Spawn a child process, forward stdout/stderr to the console, and expose an
 * `exited` promise plus a `kill()` that defaults to SIGTERM (the daemon treats
 * it as a normal shutdown). Works for any command — the gitdaemon binary or a
 * stand-in server — so the smoke test can reuse it verbatim.
 *
 * @param {{cmd:string, args?:string[], env?:object, label?:string}} options
 */
function spawnChild({ cmd, args = [], env = process.env, label = cmd }) {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

  child.stdout.on('data', data => process.stdout.write(`[${label}] ${data}`))
  child.stderr.on('data', data => process.stderr.write(`[${label}] ${data}`))

  const exited = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
    // A daemon that never spawned (a missing / non-executable binary) surfaces
    // as an 'error' event rather than an 'exit'; with no listener Node would
    // throw and take the main process down. Funnel it through the same `exited`
    // promise as an early, failed exit so the cleanup path runs.
    child.on('error', error => {
      const message = error && error.message ? error.message : String(error)
      process.stderr.write(`[${label}] spawn error: ${message}\n`)
      resolve({ code: null, signal: null, error: message })
    })
  })

  const running = () => child.exitCode === null && child.signalCode === null

  const kill = (signal = 'SIGTERM') => {
    if (running()) {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  return { child, exited, kill, running }
}

/* -------------------------------------------------------------------------- */
/* Health poll                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Poll `${baseUrl}/health` until it returns JSON `{ ok: true, … }` or the
 * budget lapses. Never throws. Resolves
 * `{ ok, status, body, attempts, error? }` — a truthy `ok` is the contract the
 * daemon advertises (`GET /health` → `{ "ok": true, "version": … }`).
 */
async function waitForHealth({
  baseUrl,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_INTERVAL_MS,
}) {
  const url = `${baseUrl}${HEALTH_PATH}`
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastStatus = 0
  let lastError = null

  while (Date.now() < deadline) {
    attempts += 1
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      lastStatus = res.status
      const body = await res.json()
      if (res.ok && body && body.ok === true) {
        return { ok: true, status: res.status, body, attempts }
      }
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastError ? String(lastError.message || lastError) : 'timeout',
    attempts,
  }
}

/* -------------------------------------------------------------------------- */
/* Injecting the daemon URL into the client                                   */
/* -------------------------------------------------------------------------- */

/**
 * Append `?server=<serverUrl>` to a load URL.
 *
 * The React client resolves its backend in this priority order
 * (`client/src/api/client.ts`): `?server=` → `window.GITDAEMON_URL` →
 * `localStorage` → default `http://127.0.0.1:4789`. The store captures that
 * value at module init, and the shell chooses a *random* free port, so the
 * client would ignore the daemon without this. The `?server=` param is the
 * reliable, pre-execution injection channel (no timing games), and it works
 * cross-origin for the Vite dev server too.
 */
function withServerParam(baseUrl, serverUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return baseUrl
  }
  url.searchParams.set('server', serverUrl)
  return url.toString()
}

/**
 * A `data:` fallback page shown when the client isn't built and the daemon
 * therefore can't serve the SPA (API-only mode). It points the client at the
 * daemon and tells the user how to build the client.
 */
function buildMissingClientPage(serverUrl) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>gitdesktop — client not built</title>
    <style>
      body { margin: 0; padding: 3rem; font: 15px/1.5 system-ui, sans-serif;
             background: #0d1117; color: #c9d1d9; }
      code { background: #161b22; padding: .15rem .4rem; border-radius: 4px; }
      h1 { font-size: 1.2rem; margin: 0 0 1rem; }
    </style>
  </head>
  <body>
    <h1>The gitdaemon server is running, but the web client hasn't been built.</h1>
    <p>The daemon is in API-only mode because <code>client/dist</code> is missing.</p>
    <p>Build the client, then relaunch:</p>
    <pre>cd client &amp;&amp; npm run build</pre>
    <p>Daemon: <code>${'' /* placeholder, replaced below */}</code><span id="s"></span></p>
    <script>
      window.GITDAEMON_URL = ${JSON.stringify(serverUrl)};
      document.getElementById('s').textContent = window.GITDAEMON_URL;
    </script>
  </body>
</html>`
  // Fill the daemon line without baking it into an attribute via interpolation.
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

module.exports = {
  LOOPBACK_HOST,
  HEALTH_PATH,
  HEALTH_TIMEOUT_MS,
  repoRoot,
  daemonBinaryCandidates,
  resolveDaemonBinary,
  resolveServeDir,
  daemonBaseUrl,
  buildDaemonEnv,
  getFreeLoopbackPort,
  spawnChild,
  waitForHealth,
  withServerParam,
  buildMissingClientPage,
}

/* -------------------------------------------------------------------------- */
/* Electron bootstrap (only when this file is the app entry)                  */
/* -------------------------------------------------------------------------- */

async function launch() {
  // Required lazily: unavailable (and unnecessary) under plain `node`.
  const { app, BrowserWindow, Menu, dialog, shell } = require('electron')

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let spawned = null // { kill, exited, running } — only when WE own the daemon
  let mainWindow = null
  let lastLoad = null
  let quitting = false
  let booted = false

  const applicationMenu = () =>
    Menu.buildFromTemplate([
      {
        label: 'gitdesktop',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
    ])

  const createWindow = ({ loadUrl, serverUrl }) => {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: 'gitdesktop (local)',
      backgroundColor: '#0d1117',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // The preload only uses contextBridge, so it runs sandboxed: no Node
        // built-ins in the preload, and a much smaller renderer attack surface.
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
        // Handed to the preload so it can set window.GITDAEMON_URL on the real
        // page before the client bundle runs (see preload.js).
        additionalArguments: [`--gitdaemon-url=${serverUrl}`],
      },
    })
    Menu.setApplicationMenu(applicationMenu())

    // Open `target="_blank"` / `window.open` links in the OS browser instead of
    // a new in-app window, and refuse any renderer-initiated navigation away
    // from the daemon origin (same-origin navigations, incl. reloads, are
    // allowed). `shell` is the Electron namespace destructured in `launch`.
    const originOf = (value) => {
      try {
        return new URL(value).origin
      } catch {
        return null
      }
    }
    const appOrigin = originOf(loadUrl)

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (originOf(url) === appOrigin) return
      event.preventDefault()
    })

    mainWindow.loadURL(loadUrl)
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    return mainWindow
  }

  const showBuildServerDialog = () => {
    const candidateList = daemonBinaryCandidates().join('\n  ')
    dialog
      .showMessageBox({
        type: 'error',
        buttons: ['OK', 'Copy build command'],
        defaultId: 0,
        title: 'gitdaemon not built',
        message: 'The gitdaemon server binary was not found.',
        detail:
          `Looked for:\n  ${candidateList}\n\n` +
          'Build it with:\n  yarn daemon:release\n' +
          '  (i.e. cargo build --release inside server/)',
      })
      .then(({ response }) => {
        if (response === 1) shell.writeTextToClipboard('cargo build --release')
        app.quit()
      })
      .catch(() => app.quit())
  }

  async function bootstrap() {
    if (booted) return
    booted = true

    // --- External backend (dev / remote): attach, don't spawn. ---
    if (process.env.GITDAEMON_URL) {
      const serverUrl = process.env.GITDAEMON_URL.replace(/\/+$/, '')
      const health = await waitForHealth({ baseUrl: serverUrl, timeoutMs: 5000 })
      if (!health.ok) {
        console.warn('[gitdesktop] GITDAEMON_URL not healthy yet:', serverUrl)
      }
      const target = process.env.VITE_DEV_SERVER_URL || serverUrl
      lastLoad = { loadUrl: withServerParam(target, serverUrl), serverUrl }
      createWindow(lastLoad)
      return
    }

    // --- We own a daemon. ---
    const serveDir = resolveServeDir()
    if (!serveDir) {
      console.warn(
        '[gitdesktop] client/dist not found — starting daemon in API-only mode. ' +
          'Build the client with: cd client && npm run build'
      )
    }

    const bin = resolveDaemonBinary()
    if (!bin) {
      showBuildServerDialog()
      return
    }

    const port = await getFreeLoopbackPort()
    const serverUrl = daemonBaseUrl(port)
    spawned = spawnChild({
      cmd: bin,
      env: buildDaemonEnv({ port, serveDir }),
      label: 'daemon',
    })

    spawned.exited.then(({ code, signal }) => {
      if (!quitting) {
        dialog.showErrorBox(
          'gitdaemon exited',
          `The gitdaemon backend exited unexpectedly (code ${code}, signal ${signal}).`
        )
      }
    })

    const health = await waitForHealth({ baseUrl: serverUrl })
    if (!health.ok) {
      console.error(
        '[gitdesktop] gitdaemon did not become healthy within 10s:',
        health.error || `status ${health.status}`
      )
    }

    // Dev override: Vite supplies the UI; the daemon we spawned supplies the
    // API on a different origin (allowed by the daemon's loopback CORS).
    if (process.env.VITE_DEV_SERVER_URL) {
      lastLoad = {
        loadUrl: withServerParam(process.env.VITE_DEV_SERVER_URL, serverUrl),
        serverUrl,
      }
      createWindow(lastLoad)
      return
    }

    // Production: the daemon serves the SPA from GITDAEMON_SERVE_DIR.
    if (serveDir) {
      lastLoad = {
        loadUrl: withServerParam(`${serverUrl}/`, serverUrl),
        serverUrl,
      }
    } else {
      lastLoad = { loadUrl: buildMissingClientPage(serverUrl), serverUrl }
    }
    createWindow(lastLoad)
  }

  app.whenReady().then(bootstrap).catch(error => {
    console.error('[gitdesktop] fatal during start:', error)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && lastLoad) {
      createWindow(lastLoad)
    } else if (BrowserWindow.getAllWindows().length === 0) {
      bootstrap()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    if (spawned) spawned.kill('SIGTERM')
  })
}

if (require.main === module) {
  launch().catch(error => {
    console.error('[gitdesktop] fatal:', error)
    process.exit(1)
  })
}
