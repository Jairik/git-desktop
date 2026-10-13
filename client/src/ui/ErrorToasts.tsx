/**
 * Toast-style error list for failed RPCs / failed operations.
 * Shows the error code, the message, and git stderr when available.
 */

import { useStore } from '../state/store'
import { Button } from './common'

export function ErrorToasts() {
  const { state, actions } = useStore()

  if (state.errors.length === 0) return null

  return (
    <div className="toasts" role="log" aria-live="polite">
      {state.errors.map((error) => (
        <div className="toast" key={error.id}>
          <div className="toast-body">
            {error.code ? <div className="toast-code">{error.code}</div> : null}
            <div className="toast-message">{error.message}</div>
            {error.detail ? <pre>{error.detail}</pre> : null}
          </div>
          <Button
            className="dismiss ghost small"
            title="Dismiss"
            aria-label="Dismiss error"
            onClick={() => actions.dismissError(error.id)}
          >
            ✕
          </Button>
        </div>
      ))}
    </div>
  )
}
