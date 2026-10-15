import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import * as os from 'os'
import * as Path from 'path'

/** Maximum time we'll wait for an agent to come back with a message. */
export const GenerationTimeoutMs = 3 * 60 * 1000

/** Maximum time we'll wait for an agent to come back with a chat reply. */
export const ChatTimeoutMs = 5 * 60 * 1000

/** Thrown when an in-flight local agent generation is cancelled. */
export class LocalAgentCancelledError extends Error {
  public constructor() {
    super('Local agent commit message generation was cancelled')
    this.name = 'LocalAgentCancelledError'
  }
}

export interface ILocalAgentCommitMessage {
  readonly title: string
  readonly description: string
}

/** A message sent to a CLI agent, asking it to reply in a conversation. */
export interface ILocalAgentChatRequest {
  /** What the user typed. */
  readonly prompt: string
  /** The model to run the turn with. */
  readonly model: string
  /** Working directory the agent runs in (usually the repository). */
  readonly cwd: string
  readonly signal: AbortSignal
  /** The conversation to continue, or null to start a new one. */
  readonly session: string | null
  readonly onProgress: LocalAgentProgressCallback
}

/** An agent's reply, plus the conversation id to use for the next turn. */
export interface ILocalAgentChatReply {
  readonly text: string
  /**
   * The id to pass back as `session` on the next turn. Agents that can't
   * report one return null, which starts a fresh conversation each time.
   */
  readonly session: string | null
}

export interface ILocalAgentModel {
  /** The id passed to the CLI's model flag */
  readonly id: string
  /** The name shown in the model picker */
  readonly label: string
  /** Optional submenu to group the model under (e.g. its provider) */
  readonly group?: string
}

/**
 * Reports what the agent is doing, for the in-progress status line. `draft`
 * is the commit message so far, for agents that stream their reply.
 */
export type LocalAgentProgressCallback = (
  message: string,
  draft?: string
) => void

/** A CLI coding agent that can write commit messages. */
export interface ILocalAgent {
  /** Stable identifier, used for persisting the user's selection */
  readonly id: string
  /** User-facing name */
  readonly name: string
  readonly defaultModel: string

  listModels(): Promise<ReadonlyArray<ILocalAgentModel>>

  generateCommitMessage(
    diff: string,
    cwd: string,
    model: string,
    signal: AbortSignal,
    onProgress: LocalAgentProgressCallback
  ): Promise<ILocalAgentCommitMessage>

  /**
   * Send a single message and return the agent's reply. `session` carries the
   * conversation between turns; agents that can't continue a conversation
   * return null and start fresh.
   */
  chat(request: ILocalAgentChatRequest): Promise<ILocalAgentChatReply>
}

/**
 * Locate a CLI binary. Apps launched from a desktop launcher often don't
 * inherit the shell's PATH, so `fallbackDirs` are checked as well. The
 * environment variable `envVar` overrides both.
 */
export function findExecutable(
  name: string,
  envVar: string,
  fallbackDirs: ReadonlyArray<string>
): string {
  const fromEnv = process.env[envVar]
  if (fromEnv) {
    return fromEnv
  }

  const fileName = __WIN32__ ? `${name}.exe` : name
  const dirs = [
    ...(process.env.PATH ?? '').split(Path.delimiter),
    ...fallbackDirs,
  ]

  for (const dir of dirs) {
    const candidate = Path.join(dir, fileName)
    if (dir && existsSync(candidate)) {
      return candidate
    }
  }

  return fileName
}

export interface IRunAgentOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly timeout?: number
  /** Called with each complete line of stdout as it arrives */
  readonly onStdoutLine?: (line: string) => void
  /** Pull a human readable error out of stdout when the CLI fails */
  readonly describeFailure?: (stdout: string) => string | null
}

/**
 * Run an agent CLI and return its stdout, translating cancellation, timeouts,
 * and missing-binary failures into friendlier errors.
 */
export function runAgentCli(
  agentName: string,
  envVar: string,
  path: string,
  args: ReadonlyArray<string>,
  options: IRunAgentOptions = {}
): Promise<string> {
  const { cwd, signal, timeout, onStdoutLine, describeFailure } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new LocalAgentCancelledError())
    }

    // Agent CLIs may read piped stdin as part of the prompt and wait for it
    // to close, so don't give them one.
    const child = spawn(path, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    let timedOut = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (onStdoutLine) {
        const lines = (pendingLine + chunk).split('\n')
        pendingLine = lines.pop() ?? ''
        lines.forEach(onStdoutLine)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192)
    })

    const kill = () => child.kill('SIGTERM')
    const timer =
      timeout !== undefined
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, timeout)
        : null
    signal?.addEventListener('abort', kill)

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', kill)
    }

    child.on('error', (e: NodeJS.ErrnoException) => {
      cleanup()
      reject(
        e.code === 'ENOENT'
          ? new Error(
              `Could not find the ${agentName} CLI. Install it or set ${envVar} to its path.`
            )
          : e
      )
    })

    child.on('close', code => {
      cleanup()

      if (signal?.aborted) {
        return reject(new LocalAgentCancelledError())
      }
      if (timedOut) {
        return reject(
          new Error(
            `${agentName} didn't finish within ${Math.round(
              (timeout ?? 0) / 1000
            )} seconds. Try a faster model or commit fewer files at once.`
          )
        )
      }
      if (code === 0) {
        return resolve(stdout)
      }

      const reason =
        describeFailure?.(stdout) ??
        lastLines(stderr) ??
        `it exited with code ${code}`
      reject(new Error(`${agentName} failed: ${reason}`))
    })
  })
}

function lastLines(text: string, count = 3): string | null {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
  return lines.length > 0 ? lines.slice(-count).join('\n') : null
}

/** Roughly 100k tokens; leaves headroom in a 128k context window. */
const MaxDiffBytes = 400 * 1024

export interface IPreparedDiff {
  readonly text: string
  readonly fileCount: number
  readonly includedFileCount: number
}

/**
 * Keep huge diffs (e.g. with build output or vendored files selected) within
 * what a model can take. Whole files are kept in order until the budget runs
 * out; the rest are listed by name so the agent still knows they changed.
 */
export function prepareDiff(
  diff: string,
  maxBytes = MaxDiffBytes
): IPreparedDiff {
  // `--patch-with-raw` output starts with one `:<modes> <shas> <status>\t<path>`
  // line per file; drop it, the patches carry the same information.
  const firstPatch = diff.indexOf('diff --git ')
  const patches = (firstPatch === -1 ? diff : diff.slice(firstPatch))
    .split(/^(?=diff --git )/m)
    .filter(p => p.length > 0)

  const included: string[] = []
  const omitted: string[] = []
  let size = 0

  for (const patch of patches) {
    if (size + patch.length <= maxBytes) {
      included.push(patch)
      size += patch.length
    } else {
      omitted.push(
        patch.slice(0, patch.indexOf('\n')).replace('diff --git ', '')
      )
    }
  }

  let text = included.join('')
  if (omitted.length > 0) {
    const names = omitted.slice(0, 200).join('\n')
    const more =
      omitted.length > 200 ? `\n...and ${omitted.length - 200} more` : ''
    text +=
      `\n# ${omitted.length} more changed file(s) were too large to include. ` +
      `Their paths (a/<path> b/<path>):\n${names}${more}\n`
  }

  return {
    text,
    fileCount: patches.length,
    includedFileCount: included.length,
  }
}

/** Run `fn` with a fresh temporary directory that's removed afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(Path.join(os.tmpdir(), 'desktop-local-agent-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Find the user's `generate-commit-message` skill, for agents that don't
 * discover it on their own.
 */
export function findCommitMessageSkill(): string | null {
  const home = os.homedir()
  const roots = [
    Path.join(home, '.agents', 'skills'),
    Path.join(home, '.claude', 'skills'),
    Path.join(home, '.gemini', 'skills'),
    Path.join(home, '.gemini', 'antigravity-cli', 'skills'),
  ]

  for (const root of roots) {
    const skill = Path.join(root, 'generate-commit-message', 'SKILL.md')
    if (existsSync(skill)) {
      return skill
    }
  }

  return null
}

/** Memoize a model listing, retrying on the next call if it fails. */
export function cachedModelList(
  load: () => Promise<ReadonlyArray<ILocalAgentModel>>
): () => Promise<ReadonlyArray<ILocalAgentModel>> {
  let promise: Promise<ReadonlyArray<ILocalAgentModel>> | null = null
  return () => {
    if (promise === null) {
      promise = load().catch(e => {
        promise = null
        throw e
      })
    }
    return promise
  }
}

/**
 * Turn an agent's reply into a summary and description. The summary is the
 * first non-empty line; everything after it is the description.
 */
export function parseCommitMessage(text: string): ILocalAgentCommitMessage {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
  const message = (
    blocks.length > 0 ? blocks[blocks.length - 1][1] : text
  ).trim()

  const lines = message.split('\n')
  const titleIndex = lines.findIndex(l => l.trim().length > 0)
  if (titleIndex === -1) {
    throw new Error('The agent returned an empty commit message')
  }

  return {
    title: lines[titleIndex].trim(),
    description: lines
      .slice(titleIndex + 1)
      .join('\n')
      .trim(),
  }
}
