/**
 * "Summarize file" action for the file/diff preview header.
 *
 * Runs `agent.summarize_file` through the store and shows the free-form
 * summary in a small panel under the button. A summary belonging to a
 * different file is ignored, so a stale result can't pass as this
 * file's summary.
 */

import { useState } from 'react'
import { useStore } from '../state/store'
import { Button, Spinner } from './common'

export function SummarizeFileButton({ file, atRef }: { file: string; atRef?: string }) {
  const { state, actions } = useStore()
  const [open, setOpen] = useState(false)
  const busy = state.fileSummaryBusy
  const summary = state.fileSummary
  const sameFile = summary !== null && summary.file === file

  const run = async () => {
    if (busy) return
    setOpen(true)
    await actions.summarizeFile(file, atRef)
  }

  return (
    <span className="summarize-button">
      <Button
        small
        variant="ghost"
        disabled={state.busy !== null}
        busy={busy}
        onClick={() => void run()}
        title={`Ask an agent to summarize ${file}`}
        aria-label={`Summarize ${file}`}
      >
        ✨ Summarize
      </Button>
      {open ? (
        <span className="summarize-panel" role="status">
          <span className="summarize-panel-head">
            <strong>Summary</strong>
            <span className="hint">{busy ? 'working…' : summary?.agent ?? ''}</span>
            <span className="grow" />
            <Button small variant="ghost" onClick={() => setOpen(false)} aria-label="Close summary">
              Close
            </Button>
          </span>
          {busy ? (
            <span className="row">
              <Spinner />
              <span className="hint">The agent is summarizing — this can take a while.</span>
            </span>
          ) : sameFile ? (
            <pre className="summarize-output">{summary.text}</pre>
          ) : (
            <span className="hint">No summary yet.</span>
          )}
        </span>
      ) : null}
    </span>
  )
}
