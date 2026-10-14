/**
 * "Agent review" affordance: a button that runs `agent.review` on a
 * commit / pull request / file target and opens the shared review panel.
 *
 * To wire another target kind, add it to `ReviewTarget` in
 * `api/types.ts` (plus its server method) and pass it here — the label
 * comes from `reviewTargetLabel` and the panel needs no changes.
 */

import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ReviewTarget } from '../api/types'
import { useStore } from '../state/store'
import { Button, Spinner } from './common'
import { ReviewPanel, reviewTargetLabel } from './ReviewPanel'

/** Deep-ish equality for the discriminated review targets. */
function targetMatches(a: ReviewTarget, b: ReviewTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.file === b.file && a.ref === b.ref
  if (a.kind === 'commit' && b.kind === 'commit') return a.sha === b.sha
  if (a.kind === 'pr' && b.kind === 'pr') return a.number === b.number
  return false
}

export function AgentReviewButton({
  target,
  label = 'Review',
  title,
  small = true,
  disabled = false,
  className,
}: {
  target: ReviewTarget
  label?: string
  title?: string
  small?: boolean
  /** Extra disabled condition (e.g. a repo-wide operation in flight). */
  disabled?: boolean
  className?: string
}) {
  const { state, actions } = useStore()
  const [open, setOpen] = useState(false)
  const reviewBusy = state.reviewBusy
  const targetLabel = useMemo(() => reviewTargetLabel(target), [target])
  const sameTarget =
    state.review !== null && targetMatches(state.review.target, target)

  // Escape closes the panel once it is open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const run = () => {
    if (reviewBusy) return
    setOpen(true)
    void actions.runReview(target)
  }

  // Clicking the scrim (not the panel itself) dismisses it.
  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setOpen(false)
  }

  return (
    <>
      <Button
        small={small}
        className={className}
        variant={sameTarget && !open ? 'default' : 'ghost'}
        disabled={disabled || state.busy !== null}
        busy={reviewBusy}
        onClick={run}
        title={title ?? `Ask an agent to review ${targetLabel}`}
        aria-label={`Agent review ${targetLabel}`}
      >
        ✨ {label}
      </Button>
      {open ? (
        <div className="review-modal-backdrop" onClick={onBackdropClick}>
          <ReviewPanel
            review={state.review}
            busy={reviewBusy}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </>
  )
}

/** Small shared spinner + label for agent work that has no panel of its own. */
export function AgentBusyLabel({ label }: { label: string }) {
  return (
    <span className="agent-busy" aria-busy="true">
      <Spinner />
      {label}
    </span>
  )
}
