/**
 * Floating progress cards for the four `/ws` progress events:
 * clone.progress, fetch.progress, push.progress, pull.progress.
 * Each frame carries `{ phase, value (0–100), detail? }`.
 */

import { useStore, type ProgressEventName } from '../state/store'
import { Button, progressEventLabel, Spinner } from './common'

const EVENTS: ProgressEventName[] = [
  'clone.progress',
  'fetch.progress',
  'push.progress',
  'pull.progress',
]

export function ProgressBars() {
  const { state, actions } = useStore()
  const active = EVENTS.filter((event) => state.progress[event])

  if (active.length === 0) return null

  return (
    <div className="progress-bars">
      {active.map((event) => {
        const frame = state.progress[event]
        if (!frame) return null
        const complete = frame.value >= 100
        return (
          <div className="progress-card" key={event}>
            <div className="head">
              <span className="label">{progressEventLabel(event)}</span>
              {complete ? (
                <span aria-hidden title="Complete">
                  ✓
                </span>
              ) : (
                <Spinner />
              )}
              <span className="grow" />
              <span>{Math.round(frame.value)}%</span>
              <Button
                className="ghost small"
                aria-label={`Hide ${event} progress`}
                title="Hide"
                onClick={() => actions.dismissProgress(event)}
              >
                ✕
              </Button>
            </div>
            <div className="bar">
              <div style={{ width: `${Math.max(0, Math.min(100, frame.value))}%` }} />
            </div>
            <div className="detail">
              {frame.phase}
              {frame.detail ? ` — ${frame.detail}` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}
