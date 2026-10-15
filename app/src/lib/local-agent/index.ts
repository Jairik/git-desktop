import { getStringArray, setStringArray } from '../local-storage'
import { agyAgent } from './agy'
import { opencodeAgent } from './opencode'
import { Disposable, Emitter } from 'event-kit'
import {
  ILocalAgent,
  ILocalAgentChatReply,
  ILocalAgentCommitMessage,
  LocalAgentProgressCallback,
  prepareDiff,
} from './shared'

export * from './shared'

/** All the CLI agents that can generate commit messages. */
export const LocalAgents: ReadonlyArray<ILocalAgent> = [opencodeAgent, agyAgent]

/** Which agent and model to generate commit messages with. */
export interface ILocalAgentSelection {
  readonly agent: string
  readonly model: string
}

const selectionKey = 'local-agent-selection'
const legacyOpencodeModelKey = 'local-agent-opencode-model'
const recentKey = 'local-agent-recent-selections'
const MaxRecentSelections = 6

export function getLocalAgent(id: string): ILocalAgent | undefined {
  return LocalAgents.find(a => a.id === id)
}

function encode({ agent, model }: ILocalAgentSelection) {
  return `${agent}|${model}`
}

function decode(value: string): ILocalAgentSelection | null {
  const sep = value.indexOf('|')
  if (sep === -1) {
    return null
  }

  const agent = value.substring(0, sep)
  const model = value.substring(sep + 1)
  return getLocalAgent(agent) && model ? { agent, model } : null
}

export function getSelectedLocalAgent(): ILocalAgentSelection {
  const stored = decode(localStorage.getItem(selectionKey) ?? '')
  if (stored !== null) {
    return stored
  }

  const legacyModel = localStorage.getItem(legacyOpencodeModelKey)
  return {
    agent: opencodeAgent.id,
    model: legacyModel ?? opencodeAgent.defaultModel,
  }
}

export function setSelectedLocalAgent(selection: ILocalAgentSelection) {
  const value = encode(selection)
  localStorage.setItem(selectionKey, value)

  const recent = getStringArray(recentKey).filter(v => v !== value)
  setStringArray(recentKey, [value, ...recent].slice(0, MaxRecentSelections))
}

/** Recently selected agent/models, most recent first, for quick switching. */
export function getRecentLocalAgents(): ReadonlyArray<ILocalAgentSelection> {
  const selected = getSelectedLocalAgent()
  const recent = getStringArray(recentKey)
    .map(decode)
    .filter((s): s is ILocalAgentSelection => s !== null)

  return recent.some(s => encode(s) === encode(selected))
    ? recent
    : [selected, ...recent]
}

/** The status of an in-flight generation, for the commit message box. */
export interface ILocalAgentStatus {
  readonly repositoryPath: string
  readonly agentName: string
  readonly model: string
  readonly message: string
  readonly detail: string | null
  readonly draft: string | null
  readonly startedAt: number
}

const statusEmitter = new Emitter()

/** Subscribe to status updates; `null` means the generation finished. */
export function onLocalAgentStatus(
  fn: (status: ILocalAgentStatus | null, repositoryPath: string) => void
): Disposable {
  return statusEmitter.on('status', ({ status, repositoryPath }) =>
    fn(status, repositoryPath)
  )
}

/** Generate a commit message for `diff` with the selected agent and model. */
export async function generateCommitMessageWithLocalAgent(
  selection: ILocalAgentSelection,
  rawDiff: string,
  repositoryPath: string,
  signal: AbortSignal
): Promise<ILocalAgentCommitMessage> {
  const agent = getLocalAgent(selection.agent)
  if (agent === undefined) {
    throw new Error(`Unknown local agent '${selection.agent}'`)
  }

  const diff = prepareDiff(rawDiff)
  const detail =
    diff.includedFileCount < diff.fileCount
      ? `${diff.includedFileCount} of ${diff.fileCount} files fit; the rest are listed by name`
      : `${diff.fileCount} ${diff.fileCount === 1 ? 'file' : 'files'}`

  let status: ILocalAgentStatus = {
    repositoryPath,
    agentName: agent.name,
    model: selection.model,
    message: 'Preparing the diff',
    detail,
    draft: null,
    startedAt: Date.now(),
  }
  const emit = (next: ILocalAgentStatus | null) =>
    statusEmitter.emit('status', { status: next, repositoryPath })
  emit(status)

  try {
    return await agent.generateCommitMessage(
      diff.text,
      repositoryPath,
      selection.model,
      signal,
      (message, draft) => {
        status = { ...status, message, draft: draft ?? status.draft }
        emit(status)
      }
    )
  } finally {
    emit(null)
  }
}

/**
 * Send a chat message with the selected agent and model. `session` continues an
 * earlier conversation; the reply carries the id to pass on the next turn.
 */
export function sendLocalAgentChat(
  selection: ILocalAgentSelection,
  prompt: string,
  session: string | null,
  cwd: string,
  signal: AbortSignal,
  onProgress: LocalAgentProgressCallback
): Promise<ILocalAgentChatReply> {
  const agent = getLocalAgent(selection.agent)
  if (agent === undefined) {
    return Promise.reject(new Error(`Unknown local agent '${selection.agent}'`))
  }

  return agent.chat({
    prompt,
    model: selection.model,
    cwd,
    signal,
    session,
    onProgress,
  })
}
