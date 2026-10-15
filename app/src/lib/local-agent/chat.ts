import { Disposable, Emitter } from 'event-kit'
import {
  getSelectedLocalAgent,
  sendLocalAgentChat,
  setSelectedLocalAgent,
  ILocalAgentSelection,
} from './index'
import { LocalAgentCancelledError } from './shared'

/** Who wrote a message in the conversation. */
export type LocalAgentChatRole = 'user' | 'agent'

export interface ILocalAgentChatTurn {
  readonly role: LocalAgentChatRole
  readonly text: string
}

export interface ILocalAgentChatState {
  /**
   * The working directory the conversation is about (usually the repository).
   * Null until the chat is opened for a repository.
   */
  readonly repositoryPath: string | null
  readonly turns: ReadonlyArray<ILocalAgentChatTurn>
  readonly isRunning: boolean
  /** What the agent is doing right now. */
  readonly status: string
  /** The reply so far, streamed while the agent writes it. */
  readonly draft: string
  readonly startedAt: number
  readonly error: string | null
  /** The agent and model the next message will go to. */
  readonly selection: ILocalAgentSelection
}

/**
 * The state lives here, outside React, so the conversation survives closing
 * and reopening the chat, and keeps running while the dialog is closed.
 */
let state: ILocalAgentChatState = {
  repositoryPath: null,
  turns: [],
  isRunning: false,
  status: '',
  draft: '',
  startedAt: 0,
  error: null,
  selection: getSelectedLocalAgent(),
}

/** The conversation id of the agent, for continuing it on the next turn. */
let session: string | null = null
let controller: AbortController | null = null

const emitter = new Emitter()

function update(next: Partial<ILocalAgentChatState>) {
  state = { ...state, ...next }
  emitter.emit('change', state)
}

export function getChatState(): ILocalAgentChatState {
  return state
}

/** Subscribe to changes; returns a disposable that stops the subscription. */
export function onChatStateChange(
  fn: (state: ILocalAgentChatState) => void
): Disposable {
  return emitter.on('change', fn)
}

/** Choose the agent and model, remembering the choice for next time. */
export function setChatSelection(selection: ILocalAgentSelection) {
  setSelectedLocalAgent(selection)
  update({ selection })
}

/** Pick up a selection changed elsewhere, e.g. the commit message menu. */
export function syncChatSelection() {
  const selection = getSelectedLocalAgent()
  if (
    selection.agent !== state.selection.agent ||
    selection.model !== state.selection.model
  ) {
    update({ selection })
  }
}

/**
 * Point the conversation at a working directory. Switching to a different
 * repository (or none) starts a fresh conversation.
 */
export function setChatRepository(repositoryPath: string | null) {
  if (state.repositoryPath === repositoryPath) {
    return
  }

  cancelChat()
  session = null
  update({
    repositoryPath,
    turns: [],
    error: null,
    isRunning: false,
    status: '',
    draft: '',
  })
}

/** Forget the conversation, keeping the agent and model selection. */
export function resetChat() {
  cancelChat()
  session = null
  update({ turns: [], error: null, status: '', draft: '' })
}

/** Stop the in-flight reply, if there is one. */
export function cancelChat() {
  controller?.abort()
}

/** Send a message to the configured agent in the repository being chatted in. */
export async function sendChatMessage(prompt: string): Promise<void> {
  const text = prompt.trim()
  if (text.length === 0 || state.isRunning || state.repositoryPath === null) {
    return
  }

  update({
    turns: [...state.turns, { role: 'user', text }],
    isRunning: true,
    status: 'Starting',
    draft: '',
    startedAt: Date.now(),
    error: null,
  })

  const abort = new AbortController()
  controller = abort

  try {
    const reply = await sendLocalAgentChat(
      state.selection,
      text,
      session,
      state.repositoryPath,
      abort.signal,
      (message, draft) =>
        update({ status: message, draft: draft ?? state.draft })
    )

    session = reply.session ?? session
    update({ turns: [...state.turns, { role: 'agent', text: reply.text }] })
  } catch (e) {
    if (!(e instanceof LocalAgentCancelledError)) {
      update({ error: e instanceof Error ? e.message : `${e}` })
    }
  } finally {
    if (controller === abort) {
      controller = null
    }
    update({ isRunning: false, status: '', draft: '' })
  }
}
