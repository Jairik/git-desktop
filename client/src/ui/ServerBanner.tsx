/**
 * Shown when the gitdaemon server is unreachable.
 * Displays the URL the client tried and a retry button, plus a field
 * to point the client at a different URL (persisted via localStorage).
 */

import { useState } from 'react'
import { useStore } from '../state/store'
import { Button, Spinner } from './common'

export function ServerBanner() {
  const { state, actions } = useStore()
  const [url, setUrl] = useState(state.serverUrl)

  // Only show once a check has definitively failed — never while the
  // initial health check is still in flight (avoids a flash on load).
  if (state.serverUp || state.serverChecking) return null

  return (
    <div className="server-banner" role="alert">
      <span className="icon" aria-hidden>
        ⚠
      </span>
      <div className="text">
        <strong>Cannot reach the git server</strong>
        <span className="url">{state.serverUrl}</span>
        <div className="hint">
          Start the gitdaemon server (default port 4789) or point the client at
          the right address — e.g. <span className="mono">?server=http://127.0.0.1:4789</span>
        </div>
      </div>
      <div className="row">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:4789"
          aria-label="Server URL"
          style={{ width: 220 }}
        />
        <Button
          small
          onClick={() => void actions.setServerUrlAndReconnect(url)}
          disabled={url.trim().length === 0}
        >
          Use URL
        </Button>
        <Button small variant="primary" busy={state.serverChecking} onClick={() => void actions.retryConnection()}>
          {state.serverChecking ? <Spinner /> : null}
          Retry
        </Button>
      </div>
    </div>
  )
}
