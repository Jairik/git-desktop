import { getBoolean, setBoolean } from '../local-storage'

/**
 * Whether to keep a local agent session (a background process) running while
 * the app is open, so the first reply of a chat doesn't pay the CLI's startup
 * cost.
 */
const warmSessionKey = 'local-agent-keep-session-warm'

export function isWarmSessionEnabled(): boolean {
  return getBoolean(warmSessionKey, false)
}

export function setWarmSessionEnabled(enabled: boolean): void {
  setBoolean(warmSessionKey, enabled)
}
