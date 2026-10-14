/**
 * Toolbar for the selected repository: current branch (+ upstream and
 * ahead/behind from `status.get`) and the network operations
 * fetch / pull / push, which emit progress on their `/ws` events.
 */

import { useState } from 'react'
import { methods } from '../api/client'
import type { CiStatus } from '../api/types'
import { splitUpstream, useStore, type AppState } from '../state/store'
import { Button, Spinner } from './common'

export function Toolbar() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const status = state.status

  const currentBranch = status?.currentBranch ?? null
  const upstream = status?.currentUpstreamBranch ?? null
  const upstreamParts = upstream ? splitUpstream(upstream) : null
  const aheadBehind = status?.branchAheadBehind ?? null
  const busy = state.busy !== null

  // Push prompt state for branches without an upstream.
  const [pushOpen, setPushOpen] = useState(false)
  const [pushRemote, setPushRemote] = useState('origin')
  const [pushRemoteBranch, setPushRemoteBranch] = useState('main')

  const openPushPrompt = () => {
    setPushRemote(upstreamParts?.remote ?? state.remotes[0]?.name ?? 'origin')
    setPushRemoteBranch(currentBranch ?? 'main')
    setPushOpen(true)
  }

  const doFetch = async () => {
    await actions.runMutation(
      'Fetch',
      () => methods.fetch(path, upstreamParts?.remote),
      'fetch.progress',
    )
  }

  // `pull` requires a remote; fall back to origin when there is no
  // upstream configured.
  const doPull = async () => {
    const remote = upstreamParts?.remote ?? state.remotes[0]?.name ?? 'origin'
    await actions.runMutation('Pull', () => methods.pull(path, remote), 'pull.progress')
  }

  const doPush = async (remote: string, remoteBranch: string) => {
    if (!currentBranch) return
    await actions.runMutation(
      'Push',
      () => methods.push(path, remote, currentBranch, remoteBranch),
      'push.progress',
    )
    setPushOpen(false)
  }

  const branchLabel = currentBranch
    ? currentBranch
    : status?.exists
      ? 'HEAD (detached)'
      : 'Unborn branch'

  // The CI roll-up is per-ref: only show it when it was read for the
  // tip that is checked out right now, so a stale result can't pass as
  // the current branch's state.
  const ci = currentBranchChecks(state)

  return (
    <div className="toolbar">
      <span className="branch-chip" title={`Current branch: ${branchLabel}`}>
        <span aria-hidden>⑂</span>
        <span className="branch-name">{branchLabel}</span>
        <span className="branch-type">local</span>
      </span>

      {ci ? (
        <span className="chip ci-chip" title={`CI roll-up: ${ci.rollUp}`}>
          ● {ci.rollUp}
        </span>
      ) : null}

      {status?.currentTip ? (
        <span className="sha-pill" title={`Tip: ${status.currentTip}`}>
          {status.currentTip.slice(0, 7)}
        </span>
      ) : null}

      {upstream ? (
        <span className="chip" title={`Tracks ${upstream}`}>
          ⇅ {upstream}
        </span>
      ) : null}

      {aheadBehind ? (
        <>
          <span className="chip" title="Commits ahead of upstream">
            <span className="up">↑ {aheadBehind.ahead}</span>
          </span>
          <span className="chip" title="Commits behind upstream">
            <span className="down">↓ {aheadBehind.behind}</span>
          </span>
        </>
      ) : null}

      <span className="spacer" />

      {state.loadingRepoData ? <Spinner /> : null}

      <Button small disabled={busy} onClick={() => void actions.refreshRepo(path)} title="Refresh repository data">
        Refresh
      </Button>
      <Button small disabled={busy} busy={state.busy === 'Fetch'} onClick={() => void doFetch()}>
        Fetch
      </Button>
      <Button small disabled={busy} busy={state.busy === 'Pull'} onClick={() => void doPull()}>
        Pull
      </Button>

      {upstreamParts && currentBranch ? (
        <Button
          small
          variant="primary"
          disabled={busy}
          busy={state.busy === 'Push'}
          onClick={() => void doPush(upstreamParts.remote, upstreamParts.branch)}
          title={`Push ${currentBranch} → ${upstream}`}
        >
          Push
        </Button>
      ) : pushOpen ? (
        <span className="push-prompt">
          <span className="hint">No upstream — push to</span>
          <input
            type="text"
            value={pushRemote}
            onChange={(e) => setPushRemote(e.target.value)}
            aria-label="Push remote"
            style={{ width: 80 }}
          />
          <input
            type="text"
            value={pushRemoteBranch}
            onChange={(e) => setPushRemoteBranch(e.target.value)}
            aria-label="Push remote branch"
            style={{ width: 120 }}
          />
          <Button
            small
            variant="primary"
            disabled={busy || !currentBranch}
            busy={state.busy === 'Push'}
            onClick={() => void doPush(pushRemote, pushRemoteBranch)}
          >
            Push
          </Button>
          <Button small variant="ghost" onClick={() => setPushOpen(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          small
          onClick={openPushPrompt}
          disabled={busy || !currentBranch}
          title="This branch has no upstream — choose a remote and branch to push to"
        >
          Push…
        </Button>
      )}
    </div>
  )
}

/**
 * The loaded CI roll-up — but only when it was read for the tip that is
 * checked out right now (CI is per-ref), so a stale result can't pass
 * as the current branch's state.
 */
function currentBranchChecks(state: AppState): CiStatus | null {
  const ci = state.ci
  if (ci === null || ci.headSha === null) return null
  const tip = state.status?.currentTip ?? null
  if (tip === null || ci.headSha !== tip) return null
  return ci
}
