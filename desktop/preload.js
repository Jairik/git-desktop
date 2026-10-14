'use strict'

/**
 * Preload for the gitdesktop thin shell.
 *
 * Runs with `contextIsolation: true` / `nodeIntegration: false`, so the
 * renderer gets no Node, no fs, and no raw ipc. The only thing that crosses the
 * bridge is a tiny, read-only `window.gitdesktop` API. We also copy the daemon
 * URL (handed over via `webPreferences.additionalArguments`) onto the real
 * page's `window.GITDAEMON_URL` *before* the client bundle runs, so the client
 * talks to the daemon we started rather than its `:4789` default. (The load
 * URL also carries `?server=` — see `withServerParam` in main.js — so the URL
 * reaches the client even if `executeInMainWorld` were unavailable.)
 */

const { contextBridge } = require('electron')

const DAEMON_URL_FLAG = '--gitdaemon-url='

/** Read the daemon URL the main process passed through extra argv. */
function daemonUrlFromArgv() {
  const arg = process.argv.find(a => a.startsWith(DAEMON_URL_FLAG))
  return arg ? arg.slice(DAEMON_URL_FLAG.length) : null
}

function expose() {
  const daemonUrl = daemonUrlFromArgv()

  // Set window.GITDAEMON_URL in the main world before the page scripts run.
  // Best-effort: guarded so an unexpected API shape can never break startup.
  if (daemonUrl && typeof contextBridge.executeInMainWorld === 'function') {
    try {
      contextBridge.executeInMainWorld({
        func: url => {
          window.GITDAEMON_URL = url
        },
        args: [daemonUrl],
      })
    } catch {
      /* non-fatal — ?server= query param already carries the URL */
    }
  }

  contextBridge.exposeInMainWorld('gitdesktop', {
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    daemonUrl: daemonUrl || null,
  })
}

expose()
