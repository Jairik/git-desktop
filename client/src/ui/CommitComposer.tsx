/**
 * Commit composer: summary + description + the primary Commit button,
 * plus the "✨ Generate message" action.
 *
 * Generate runs `agent.commit_message` on the selected repo (staged
 * changes) — an LLM CLI on the server, so it can be slow: the button is
 * disabled with a spinner while it runs. The returned free-form message
 * is split on the first blank line into summary + description
 * (`splitCommitMessage`).
 *
 * The button only appears when at least one agent is available
 * (`agentsReady`) — otherwise the hint points at the Agents tab.
 */

import { useStore } from '../state/store'
import { Button, Spinner } from './common'

export function CommitComposer({
  summary,
  description,
  onSummaryChange,
  onDescriptionChange,
  busy,
  canCommit,
  onCommit,
  selectedCount,
  totalCount,
  children,
}: {
  summary: string
  description: string
  onSummaryChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  busy: boolean
  canCommit: boolean
  onCommit: () => void
  /** Number of files selected for the commit. */
  selectedCount: number
  totalCount: number
  /** Extra controls rendered next to Commit (e.g. Discard selected). */
  children?: React.ReactNode
}) {
  const { state, actions } = useStore()
  const generating = state.commitMessageBusy

  const generate = async () => {
    if (generating) return
    const draft = await actions.generateCommitMessage()
    if (draft === null) return
    onSummaryChange(draft.summary)
    onDescriptionChange(draft.description)
  }

  return (
    <div className="commit-box">
      <div className="commit-inputs">
        <input
          type="text"
          placeholder="Summary (required)"
          value={summary}
          onChange={(e) => onSummaryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onCommit()
            }
          }}
          aria-label="Commit summary"
        />
        <textarea
          rows={3}
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          aria-label="Commit description"
        />
      </div>
      <div className="commit-actions">
        <Button
          variant="primary"
          disabled={!canCommit || busy}
          busy={state.busy === 'Commit'}
          onClick={() => void onCommit()}
        >
          Commit
        </Button>

        {state.agentsLoading ? (
          <span className="hint" aria-busy="true">
            <Spinner /> Looking for AI agents on the server…
          </span>
        ) : actions.agentsReady ? (
          <Button
            small
            className="agent-generate"
            disabled={busy || generating}
            busy={generating}
            onClick={() => void generate()}
            title="Ask an agent to write a commit message from the staged changes"
          >
            ✨ Generate message
          </Button>
        ) : (
          <span className="hint" title="No AI agent available on the server">
            ✨ Generate message — set up an agent in the Agents tab
          </span>
        )}

        <span className="hint">
          {selectedCount} of {totalCount} file{totalCount === 1 ? '' : 's'} selected
        </span>
        <span className="grow" />
        {children}
      </div>
      {generating ? (
        <div className="hint" aria-busy="true">
          The agent is writing a commit message — this can take a while.
        </div>
      ) : null}
    </div>
  )
}
