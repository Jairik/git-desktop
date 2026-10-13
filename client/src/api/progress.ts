/**
 * WebSocket progress channel.
 *
 * Connects to `<base>/ws` (same base URL as the RPC endpoint, `http`→`ws`)
 * and fans out `{ event, data }` frames to subscribers. The socket
 * auto-reconnects with exponential backoff; listeners registered while
 * disconnected still receive frames once reconnected.
 *
 * Events (per the contract): `clone.progress`, `fetch.progress`,
 * `push.progress`, `pull.progress`, each with
 * `{ phase, value (0–100), detail? }`.
 */

import type { ProgressFrame } from './types'

type Listener = (frame: ProgressFrame) => void
type ConnectionListener = (connected: boolean) => void

const listeners = new Set<Listener>()
const connectionListeners = new Set<ConnectionListener>()

let socket: WebSocket | null = null
let baseUrl: string | null = null
let connectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connected = false

const MAX_BACKOFF_MS = 15_000

/** Convert the http(s) base URL to the ws(s) endpoint (`/ws`). */
function toWebSocketUrl(base: string): string {
  const rest = base.replace(/^http/, 'ws')
  return `${rest.replace(/\/+$/, '')}/ws`
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  connectAttempt += 1
  const delay = Math.min(500 * 2 ** (connectAttempt - 1), MAX_BACKOFF_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (baseUrl) void openSocket(baseUrl)
  }, delay)
}

function setConnected(value: boolean): void {
  if (connected === value) return
  connected = value
  for (const cb of connectionListeners) cb(value)
}

function openSocket(base: string): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }
  let ws: WebSocket
  try {
    ws = new WebSocket(toWebSocketUrl(base))
  } catch {
    // Malformed URL or refused construction — retry later.
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    connectAttempt = 0
    setConnected(true)
  }
  ws.onmessage = (event: MessageEvent) => {
    try {
      const frame = JSON.parse(String(event.data)) as ProgressFrame
      if (frame && typeof frame.event === 'string') {
        for (const cb of listeners) cb(frame)
      }
    } catch {
      /* ignore malformed frames */
    }
  }
  ws.onerror = () => {
    // `onclose` always follows; nothing to do here.
  }
  ws.onclose = () => {
    setConnected(false)
    socket = null
    scheduleReconnect()
  }
}

/** Tear down the current socket and reconnect against `base`. */
export function setProgressBaseUrl(base: string): void {
  const clean = base.replace(/\/+$/, '')
  if (baseUrl === clean && socket) return
  baseUrl = clean
  teardown()
  void openSocket(clean)
}

function teardown(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      /* already closing */
    }
    socket = null
  }
  setConnected(false)
}

/** Subscribe to every progress frame. Returns an unsubscribe function. */
export function onProgress(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Subscribe to a single progress event name (e.g. `'fetch.progress'`). */
export function subscribe(
  event: string,
  cb: (data: unknown) => void,
): () => void {
  return onProgress((frame) => {
    if (frame.event === event) cb(frame.data)
  })
}

/** Subscribe to connection state changes of the progress socket. */
export function onConnectionChange(cb: ConnectionListener): () => void {
  connectionListeners.add(cb)
  return () => {
    connectionListeners.delete(cb)
  }
}

export function isProgressConnected(): boolean {
  return connected
}
