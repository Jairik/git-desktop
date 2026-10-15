import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import {
  ChatTimeoutMs,
  ILocalAgentChatReply,
  LocalAgentCancelledError,
  LocalAgentProgressCallback,
} from './shared'

/**
 * A long-lived `agy` process that answers turn after turn over its streaming
 * stdin/stdout protocol. Starting the CLI costs a few seconds and a
 * conversation is re-established on every `--print` run, so keeping one
 * process around makes the first reply of a chat much quicker (the status
 * shows up immediately and a simple turn drops from ~6s to ~2s).
 */
export interface IWarmSessionTarget {
  readonly executable: string
  /** The repository the session runs in. */
  readonly cwd: string
  readonly model: string
}

interface IPendingTurn {
  readonly onProgress: LocalAgentProgressCallback
  readonly resolve: (reply: ILocalAgentChatReply) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly detach: () => void
  draft: string
}

interface IWarmSession {
  readonly key: string
  readonly process: ChildProcess
  conversationId: string | null
  pending: IPendingTurn | null
  buffer: string
  stderr: string
  stopped: boolean
}

let current: IWarmSession | null = null

function keyOf(target: IWarmSessionTarget) {
  return `${target.executable}\u0000${target.cwd}\u0000${target.model}`
}

/** Whether a live session for this exact target is already running. */
export function hasWarmSession(target: IWarmSessionTarget): boolean {
  return current !== null && current.key === keyOf(target) && !current.stopped
}

/** Start the session for this target, reusing it if it already matches. */
export function ensureWarmSession(target: IWarmSessionTarget): void {
  if (hasWarmSession(target)) {
    return
  }

  stopWarmSession(new Error('The agent session was restarted'))

  const process = spawn(
    target.executable,
    [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--mode',
      'plan',
      '--model',
      target.model,
    ],
    { cwd: target.cwd, stdio: ['pipe', 'pipe', 'pipe'] }
  )

  const session: IWarmSession = {
    key: keyOf(target),
    process,
    conversationId: null,
    pending: null,
    buffer: '',
    stderr: '',
    stopped: false,
  }

  current = session

  process.stdout?.setEncoding('utf8')
  process.stdout?.on('data', (chunk: string) => handleData(session, chunk))
  process.stderr?.setEncoding('utf8')
  process.stderr?.on('data', (chunk: string) => {
    session.stderr = (session.stderr + chunk).slice(-8192)
  })

  // Writing to a stdin that's already gone would throw; surface it as a
  // failed turn instead.
  process.stdin?.on('error', () => {})

  process.on('error', (error: NodeJS.ErrnoException) => {
    fail(session, spawnError(target, error))
  })

  process.on('close', code => {
    if (!session.stopped) {
      fail(session, exitedError(session, code))
    }
  })
}

/** Throw away the current session, failing any turn that was in flight. */
export function stopWarmSession(reason: Error) {
  const session = current
  current = null
  if (session === null) {
    return
  }

  session.stopped = true
  fail(session, reason)
  session.process.kill('SIGTERM')
}

/** Send a message and resolve with the reply once the turn completes. */
export function sendWarmTurn(
  target: IWarmSessionTarget,
  prompt: string,
  signal: AbortSignal,
  onProgress: LocalAgentProgressCallback
): Promise<ILocalAgentChatReply> {
  if (signal.aborted) {
    return Promise.reject(new LocalAgentCancelledError())
  }

  ensureWarmSession(target)

  const session = current
  if (session === null) {
    return Promise.reject(new Error('Could not start the Antigravity session'))
  }

  if (session.pending !== null) {
    return Promise.reject(
      new Error('Antigravity is still answering the previous message')
    )
  }

  return new Promise<ILocalAgentChatReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopWarmSession(
        new Error(
          `Antigravity didn't finish within ${Math.round(
            ChatTimeoutMs / 1000
          )} seconds.`
        )
      )
    }, ChatTimeoutMs)

    // The CLI has no way to cancel a single turn, so drop the whole session.
    const onAbort = () => stopWarmSession(new LocalAgentCancelledError())
    signal.addEventListener('abort', onAbort)
    const detach = () => signal.removeEventListener('abort', onAbort)

    session.pending = {
      onProgress,
      resolve,
      reject,
      timer,
      detach,
      draft: '',
    }

    const message = {
      event: 'user',
      message: { content: [{ type: 'text', text: prompt }] },
    }

    session.process.stdin?.write(`${JSON.stringify(message)}\n`)
  })
}

function finish(session: IWarmSession, text: string) {
  const pending = session.pending
  if (pending === null) {
    return
  }

  session.pending = null
  clearTimeout(pending.timer)
  pending.detach()
  pending.resolve({ text, session: session.conversationId })
}

function fail(session: IWarmSession, error: Error) {
  const pending = session.pending
  if (pending === null) {
    return
  }

  session.pending = null
  clearTimeout(pending.timer)
  pending.detach()
  pending.reject(error)
}

function handleData(session: IWarmSession, chunk: string) {
  session.buffer += chunk

  const lines = session.buffer.split('\n')
  session.buffer = lines.pop() ?? ''
  lines.forEach(line => handleLine(session, line))
}

function handleLine(session: IWarmSession, line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) {
    return
  }

  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    return
  }

  if (event.event === 'init' && typeof event.conversation_id === 'string') {
    session.conversationId = event.conversation_id
    return
  }

  const pending = session.pending
  if (pending === null) {
    return
  }

  if (event.event === 'step_update') {
    const update = event.step_update
    if (update === undefined) {
      return
    }

    if (update.step_type === 'tool' && update.state === 'ACTIVE') {
      pending.onProgress(`Using ${update.tool_name}`, pending.draft)
    } else if (typeof update.text_delta === 'string') {
      pending.draft += update.text_delta
      pending.onProgress('Writing a reply', pending.draft)
    } else if (update.step_type === 'agent_response') {
      pending.onProgress('Thinking', pending.draft)
    }
    return
  }

  if (event.event === 'error') {
    stopWarmSession(new Error(describeError(event)))
    return
  }

  if (event.event === 'result') {
    const response =
      typeof event.result?.response === 'string'
        ? event.result.response.trim()
        : ''
    const text =
      pending.draft.trim().length > 0 ? pending.draft.trim() : response

    if (event.result?.status !== 'SUCCESS' && text.length === 0) {
      stopWarmSession(new Error(describeResult(event.result)))
      return
    }

    if (text.length === 0) {
      finish(session, '')
      return
    }

    finish(session, text)
  }
}

function describeError(event: any): string {
  const detail = event.error?.message ?? event.message ?? event.error
  return typeof detail === 'string' && detail.length > 0
    ? `Antigravity failed: ${detail}`
    : 'Antigravity failed'
}

function describeResult(result: any): string {
  const detail = result?.error?.message ?? result?.error ?? result?.status
  return typeof detail === 'string' && detail.length > 0
    ? `Antigravity failed: ${detail}`
    : 'Antigravity did not return a reply'
}

function spawnError(
  target: IWarmSessionTarget,
  error: NodeJS.ErrnoException
): Error {
  if (error.code === 'ENOENT') {
    return existsSync(target.cwd)
      ? new Error(
          'Could not find the Antigravity CLI. Install it or set AGY_BIN to its path.'
        )
      : new Error(`The folder ${target.cwd} could not be found.`)
  }

  return error
}

function exitedError(session: IWarmSession, code: number | null): Error {
  const detail = session.stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-2)
    .join(' ')

  return new Error(
    detail.length > 0
      ? `Antigravity stopped: ${detail}`
      : `Antigravity stopped unexpectedly (exit code ${code ?? 'unknown'})`
  )
}
