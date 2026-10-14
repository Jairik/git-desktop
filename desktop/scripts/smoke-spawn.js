'use strict'

/**
 * Logic smoke test for the desktop shell — no Electron required.
 *
 * It reuses the SAME helpers as main.js (port-pick → spawn → /health poll) and
 * proves the flow end to end:
 *
 *   1. pick a free loopback port
 *   2. if ../server/target/{debug,release}/gitdaemon exists, spawn it with the
 *      contract env (GITDAEMON_PORT + GITDAEMON_SERVE_DIR when client/dist is
 *      built); otherwise spawn a tiny built-in stand-in that serves `{ok:true}`
 *      at /health and a small HTML document at /
 *   3. poll /health until it returns `{ ok: true }`
 *   4. GET / and GET /health
 *   5. print PASS/FAIL, kill the child, exit
 *
 * Usage:
 *   node desktop/scripts/smoke-spawn.js            # real daemon if present, else stand-in
 *   node desktop/scripts/smoke-spawn.js --standin  # force the stand-in
 *
 * Verdict: the shell's contract with the daemon is the `/health` response, so
 * that is the gate for the real daemon (its `/` only serves the SPA once the
 * server implements GITDAEMON_SERVE_DIR — a server-side concern). The stand-in
 * additionally asserts `/` returns HTML, exercising the serve path the shell
 * depends on.
 */

const http = require('http')

const {
  daemonBaseUrl,
  resolveDaemonBinary,
  resolveServeDir,
  buildDaemonEnv,
  getFreeLoopbackPort,
  spawnChild,
  waitForHealth,
} = require('../main.js')

const FORCE_STAND_IN = process.argv.includes('--standin')

/** A minimal stand-in daemon: `{ok:true}` at /health, HTML at everything else. */
function startStandIn(port) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, standin: true }))
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><title>gitdaemon stand-in</title><h1>gitdesktop stand-in</h1>'
    )
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const exited = new Promise(r => server.once('close', r))
      const kill = () =>
        new Promise(r =>
          server.close(() => setTimeout(r, 50))
        )
      resolve({ kind: 'stand-in', kill, exited, killNow: () => server.close() })
    })
  })
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  const bin = resolveDaemonBinary()
  const useStandIn = FORCE_STAND_IN || !bin
  const serveDir = resolveServeDir()

  const port = await getFreeLoopbackPort()
  const serverUrl = daemonBaseUrl(port)

  console.log('--- gitdesktop shell smoke ---')
  console.log(`url:      ${serverUrl}`)
  console.log(`binary:   ${bin || '(none found)'}`)
  console.log(`serveDir: ${serveDir || '(client/dist not built)'}`)
  console.log(`mode:     ${useStandIn ? 'stand-in' : `spawn ${bin}`}`)

  let handle
  if (useStandIn) {
    handle = await startStandIn(port)
  } else {
    handle = spawnChild({
      cmd: bin,
      env: buildDaemonEnv({ port, serveDir }),
      label: 'daemon',
    })
  }

  const results = { health: false, healthBody: null, root: null }

  try {
    const health = await waitForHealth({ baseUrl: serverUrl })
    results.health = health.ok
    results.healthBody = health.body || { error: health.error, status: health.status }

    try {
      const res = await fetch(`${serverUrl}/`, { signal: AbortSignal.timeout(3000) })
      const text = await res.text()
      results.root = {
        status: res.status,
        isHtml: /^\s*<(!doctype|html)/i.test(text),
        snippet: text.slice(0, 60).replace(/\s+/g, ' ').trim(),
      }
    } catch (error) {
      results.root = { error: String(error.message || error) }
    }
  } finally {
    handle.kill ? handle.kill('SIGTERM') : handle.killNow()
    await Promise.race([sleep(1000), handle.exited])
  }

  // --- report ---
  const healthVerdict = results.health ? 'PASS' : 'FAIL'
  console.log(`\nhealth:   ${healthVerdict}  body=${JSON.stringify(results.healthBody)}`)

  let rootVerdict
  if (results.root && results.root.error) {
    rootVerdict = 'FAIL'
    console.log(`root:     FAIL  (${results.root.error})`)
  } else if (results.root.status === 200 && results.root.isHtml) {
    rootVerdict = 'PASS'
    console.log(
      `root:     PASS  status=${results.root.status} "${results.root.snippet}"`
    )
  } else {
    console.log(
      `root:     INFO  status=${results.root.status} "${results.root.snippet}" ` +
        `(daemon serves the SPA via GITDAEMON_SERVE_DIR; a build that predates ` +
        `that returns 404 here)`
    )
  }

  const expectRoot = useStandIn
  const pass =
    results.health === true &&
    (!expectRoot || (results.root && rootVerdict === 'PASS'))

  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

main().catch(error => {
  console.error('[smoke] unexpected failure:', error)
  process.exit(1)
})
