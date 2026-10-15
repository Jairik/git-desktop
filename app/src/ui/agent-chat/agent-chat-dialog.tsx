import * as React from 'react'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Button } from '../lib/button'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { showContextualMenu } from '../../lib/menu-item'
import { shell } from '../../lib/app-shell'
import { getLocalAgent } from '../../lib/local-agent'
import { MarkdownText } from './markdown-text'
import {
  cancelChat,
  getChatState,
  ILocalAgentChatState,
  onChatStateChange,
  resetChat,
  sendChatMessage,
  setChatRepository,
  setChatSelection,
  syncChatSelection,
} from '../../lib/local-agent/chat'
import {
  buildLocalAgentMenu,
  formatLocalAgentSelection,
} from '../lib/local-agent-menu'

interface IAgentChatDialogProps {
  /** The repository to chat about, or null when none is selected. */
  readonly repository: Repository | null
  readonly onDismissed: () => void
}

interface IAgentChatDialogState {
  readonly chat: ILocalAgentChatState
  readonly input: string
  /** Ticks while a reply is in flight so the elapsed time stays current */
  readonly now: number
}

/**
 * A chat box for the configured local CLI agent (opencode, Antigravity, …).
 * The conversation lives in the local agent chat store so it survives closing
 * the dialog and keeps running in the background.
 */
export class AgentChatDialog extends React.Component<
  IAgentChatDialogProps,
  IAgentChatDialogState
> {
  private subscription: Disposable | null = null
  private timer: number | null = null
  private transcriptElement: HTMLDivElement | null = null

  public constructor(props: IAgentChatDialogProps) {
    super(props)
    this.state = { chat: getChatState(), input: '', now: Date.now() }
  }

  public componentDidMount() {
    this.subscription = onChatStateChange(chat =>
      this.setState({ chat, now: Date.now() })
    )

    syncChatSelection()
    setChatRepository(this.props.repository?.path ?? null)
    this.setState({ chat: getChatState() })
  }

  public componentWillUnmount() {
    this.subscription?.dispose()
    this.stopTimer()
  }

  public componentDidUpdate() {
    if (this.state.chat.isRunning) {
      this.startTimer()
    } else {
      this.stopTimer()
    }

    const transcript = this.transcriptElement
    if (transcript !== null) {
      transcript.scrollTop = transcript.scrollHeight
    }
  }

  private startTimer() {
    if (this.timer === null) {
      this.timer = window.setInterval(
        () => this.setState({ now: Date.now() }),
        1000
      )
    }
  }

  private stopTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private onTranscriptRef = (element: HTMLDivElement | null) => {
    this.transcriptElement = element
  }

  private onInputChange = (event: React.FormEvent<HTMLTextAreaElement>) => {
    this.setState({ input: event.currentTarget.value })
  }

  private onInputKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      this.send()
    }
  }

  private send = () => {
    const prompt = this.state.input
    if (prompt.trim().length === 0 || this.state.chat.isRunning) {
      return
    }

    this.setState({ input: '' })
    sendChatMessage(prompt)
  }

  private onPickAgent = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()

    const items = await buildLocalAgentMenu(
      this.state.chat.selection,
      setChatSelection
    )

    showContextualMenu(items)
  }

  private get agentName() {
    const { selection } = this.state.chat
    return getLocalAgent(selection.agent)?.name ?? selection.agent
  }

  /**
   * Agents link to the web and to files in the repository. Web links open in
   * the browser, file links reveal in the file manager, anything else is left
   * alone (the click never navigates the app itself).
   */
  private onLinkClick = (url: string) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return
    }

    if (/^file:\/\//i.test(url)) {
      try {
        let pathname = decodeURIComponent(new URL(url).pathname)
        if (__WIN32__ && /^\/[a-zA-Z]:/.test(pathname)) {
          pathname = pathname.slice(1)
        }
        shell.showItemInFolder(pathname)
      } catch {
        // Ignore links we can't make sense of
      }
    }
  }

  private renderStatus() {
    const { chat, now } = this.state
    const elapsed = Math.max(0, Math.floor((now - chat.startedAt) / 1000))

    return (
      <div className="agent-chat-turn agent-chat-turn-agent agent-chat-status">
        <div className="agent-chat-author">
          <span className="agent-chat-orb" />
          {this.agentName}
          <span className="agent-chat-model">{chat.selection.model}</span>
          <span className="agent-chat-elapsed">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        </div>
        <div className="agent-chat-step" key={chat.status}>
          {chat.status}
          <span className="agent-chat-dots" />
        </div>
        {chat.draft.length > 0 && (
          <div className="agent-chat-text agent-chat-draft">{chat.draft}</div>
        )}
      </div>
    )
  }

  private renderTranscript() {
    const { chat } = this.state

    if (chat.turns.length === 0 && !chat.isRunning) {
      return (
        <p className="agent-chat-empty">
          {chat.repositoryPath === null
            ? 'Open a repository to chat with an agent about it.'
            : `Ask ${this.agentName} anything about this repository.`}
        </p>
      )
    }

    return (
      <>
        {chat.turns.map((turn, index) => (
          <div
            key={index}
            className={`agent-chat-turn agent-chat-turn-${turn.role}`}
          >
            <div className="agent-chat-author">
              {turn.role === 'user' ? 'You' : this.agentName}
            </div>
            {turn.role === 'user' ? (
              <div className="agent-chat-text">{turn.text}</div>
            ) : (
              <MarkdownText text={turn.text} onLinkClick={this.onLinkClick} />
            )}
          </div>
        ))}
        {chat.isRunning ? this.renderStatus() : null}
      </>
    )
  }

  public render() {
    const { chat, input } = this.state
    const canSend =
      !chat.isRunning && chat.repositoryPath !== null && input.trim().length > 0
    const selectionLabel = formatLocalAgentSelection(chat.selection)

    return (
      <Dialog
        id="agent-chat"
        title="Agent chat"
        onDismissed={this.props.onDismissed}
        onSubmit={this.send}
      >
        {chat.error !== null ? <DialogError>{chat.error}</DialogError> : null}

        <DialogContent className="agent-chat-content">
          <div className="agent-chat-transcript" ref={this.onTranscriptRef}>
            {this.renderTranscript()}
          </div>
          <div className="agent-chat-composer">
            <Button
              className="agent-chat-target-button"
              onClick={this.onPickAgent}
              tooltip={`Agent: ${selectionLabel}`}
              ariaLabel={`Choose agent and model. Currently ${selectionLabel}`}
              disabled={chat.isRunning}
            >
              <Octicon symbol={octicons.sparkle} />
              <span className="agent-chat-target-agent">{this.agentName}</span>
              <span className="agent-chat-target-model">
                {chat.selection.model}
              </span>
              <Octicon
                symbol={octicons.chevronDown}
                className="agent-chat-target-chevron"
              />
            </Button>
            <textarea
              className="agent-chat-input"
              placeholder={
                __DARWIN__
                  ? 'Ask the agent… (⏎ to send, ⇧⏎ for a new line)'
                  : 'Ask the agent… (Enter to send, Shift+Enter for a new line)'
              }
              value={input}
              onChange={this.onInputChange}
              onKeyDown={this.onInputKeyDown}
              rows={3}
              autoFocus={true}
            />
          </div>
        </DialogContent>

        <DialogFooter>
          {chat.isRunning ? (
            <Button onClick={cancelChat} className="agent-chat-footer-button">
              <Octicon symbol={octicons.squareCircle} />
              Stop
            </Button>
          ) : chat.turns.length > 0 ? (
            <Button onClick={resetChat} className="agent-chat-footer-button">
              New chat
            </Button>
          ) : null}

          <OkCancelButtonGroup
            className="agent-chat-actions"
            okButtonText="Send"
            okButtonDisabled={!canSend}
            cancelButtonText="Close"
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
