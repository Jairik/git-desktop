/**
 * Smoke test for the "server unreachable" path:
 * 1. SSR-renders the whole app (initial load state, no server reachable)
 *    to prove nothing throws during render.
 * 2. Exercises the real api/client + api/progress failure paths against
 *    a dead port to prove the guards don't crash.
 *
 * Run with:  npm run smoke
 */

import React from 'react'
import { renderToString } from 'react-dom/server'
import App from '../src/App'
import { RpcError, health, rpc, setServerUrl } from '../src/api/client'
import { onConnectionChange, setProgressBaseUrl, subscribe } from '../src/api/progress'
import { StoreProvider } from '../src/state/store'

// A dead port: nothing listens here.
const DEAD = 'http://127.0.0.1:4799'

/* ------------------------------ render path ----------------------- */

// Minimal browser globals used at module scope / during render.
;(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}

const html = renderToString(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>,
)

for (const needle of ['GitDaemon', 'No repository selected', 'Repositories']) {
  if (!html.includes(needle)) {
    throw new Error(`SSR smoke failed: missing "${needle}" in output`)
  }
}
console.log(`[1/2] SSR render OK (${html.length} chars)`)

/* ---------------------------- network path ------------------------ */

setServerUrl(DEAD)

try {
  await rpc('repo.list', {})
  throw new Error('rpc() should have failed against a dead server')
} catch (error) {
  if (!(error instanceof RpcError) || error.code !== 'unreachable') throw error
  console.log(`[2/2] rpc() failed gracefully: ${error.message}`)
}

try {
  await health()
  throw new Error('health() should have failed against a dead server')
} catch (error) {
  if (!(error instanceof RpcError) || error.code !== 'unreachable') throw error
  console.log(`      health() failed gracefully: ${error.message}`)
}

let sawDisconnect = false
const unsubscribe = onConnectionChange((up) => {
  if (!up) sawDisconnect = true
})

// Connecting the progress socket against a dead server must not throw,
// and should retry with backoff. Count socket constructions to observe
// the retry.
let constructions = 0
const OriginalWebSocket = globalThis.WebSocket
class CountingWebSocket extends OriginalWebSocket {
  constructor(url: string | URL) {
    super(url)
    constructions += 1
  }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = CountingWebSocket
try {
  setProgressBaseUrl(DEAD)
  await new Promise((resolve) => setTimeout(resolve, 2000))
} finally {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket
}
unsubscribe()
const unsubscribe2 = subscribe('fetch.progress', () => {})
unsubscribe2()
void sawDisconnect
if (constructions < 2) {
  throw new Error(
    `expected the progress socket to retry with backoff (constructions=${constructions})`,
  )
}
console.log(`      progress WebSocket retried ${constructions}x with backoff, no crash`)

console.log('SMOKE OK')
// Retry timers keep the event loop alive — exit explicitly.
process.exit(0)
