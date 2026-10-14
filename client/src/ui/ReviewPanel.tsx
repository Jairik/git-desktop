/**
 * Review panel: the modal that shows an `agent.review` result.
 *
 * The agent's output is free-form text (see the contract) — it is
 * rendered as-is, never parsed. The panel is shared by the review
 * buttons in History (commits), Pull Requests and the file preview, so
 * the last reviewed target lives in the store and the modal just
 * reflects it.
 */

import { useEffect, useState } from 'react'
import type { ReviewTarget } from '../api/types'
import type { ReviewResult } from '../state/store'
import { Button, EmptyState, Spinner } from './common'

/** Human label for a review target (used in headers and toasts). */
export function reviewTargetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case 'file':
      return target.ref ? `${target.file} @ ${target.ref}` : target.file
    case 'commit':
      return `commit ${target.sha.slice(0, 7)}`
    case 'pr':
      return `PR #${target.number}`
    default:
      return 'target'
  }
}

/** Copy-to-clipboard button with a transient "Copied" confirmation. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard is unavailable (insecure context / denied) — nothing
      // useful to show, the text stays selectable in the panel.
    }
  }

  return (
    <Button small onClick={() => void copy()} disabled={copied} title="Copy the agent output">
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function ReviewPanel({
  review,
  busy,
  onClose,
}: {
  review: ReviewResult | null
  busy: boolean
  onClose: () => void
}) {
  return (
    <div className="review-modal" role="dialog" aria-modal="true" aria-label="Agent review">
      <header className="review-modal-head">
        <strong>Agent review</strong>
        {review ? <span className="mono hint">{reviewTargetLabel(review.target)}</span> : null}
        <span className="grow" />
        {review ? <CopyButton text={review.output} /> : null}
        <Button small variant="ghost" onClick={onClose} aria-label="Close review">
          Close
        </Button>
      </header>

      <div className="review-modal-body">
        {busy ? (
          <div className="review-busy" aria-busy="true">
            <Spinner />
            <span>The agent is reviewing — this can take a while.</span>
          </div>
        ) : review === null ? (
          <EmptyState icon="🛡" title="No review yet">
            Pick a commit, pull request or file and run “Agent review”.
          </EmptyState>
        ) : (
          <>
            {review.summary ? <p className="review-summary">{review.summary}</p> : null}
            <pre className="review-output" aria-busy={busy}>
              {review.output}
            </pre>
          </>
        )}
      </div>

      <footer className="review-modal-foot hint">
        {review ? `Agent: ${review.agent}` : 'Output is shown exactly as the agent wrote it.'}
      </footer>
    </div>
  )
}
