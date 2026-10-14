/**
 * Checks / CI tab: `ci.status` for the repository's current branch —
 * a roll-up header (success / pending / failure) plus every check run
 * and commit status, each linking out to its details page.
 *
 * Like the Pull Requests tab it is served by the server's `gh` CLI, so
 * `state.ghMessage` (missing/unauthenticated `gh`, no GitHub remote)
 * renders the shared setup panel instead.
 */

import { useEffect, useRef } from 'react'
import type { Check, CiRollUp } from '../api/types'
import { useStore } from '../state/store'
import { Button, EmptyState, Spinner } from './common'
import { GitHubSetupPanel } from './GitHubSetup'

const ROLL_UP_LABEL: Record<CiRollUp, string> = {
  success: 'All checks passed',
  pending: 'Checks pending',
  failure: 'Some checks failed',
}

const ROLL_UP_ICON: Record<CiRollUp, string> = {
  success: '✓',
  pending: '◐',
  failure: '✗',
}

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral'])
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
])

type BadgeTone = 'success' | 'pending' | 'failure' | 'neutral'

function badgeTone(check: Check): BadgeTone {
  if (check.status !== 'completed') return 'pending'
  const conclusion = (check.conclusion ?? '').toLowerCase()
  if (SUCCESS_CONCLUSIONS.has(conclusion)) return 'success'
  if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failure'
  return 'neutral'
}

function badgeLabel(check: Check): string {
  if (check.status !== 'completed') {
    return check.status === 'queued' ? 'Queued' : 'In progress'
  }
  const conclusion = check.conclusion
  if (!conclusion) return 'Completed'
  return conclusion.charAt(0).toUpperCase() + conclusion.slice(1).replace(/_/g, ' ')
}

export function ChecksTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const branch = state.status?.currentBranch ?? null
  const busy = state.busy !== null
  const ci = state.ci
  const loading = state.ciLoading

  // `github.status` + `github.remote`: once per repo, when the tab is
  // opened (never on every repo switch).
  const ghLoadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (ghLoadedFor.current === path) return
    ghLoadedFor.current = path
    void actions.loadGitHubStatus(path)
  }, [path, actions])

  // CI is per-ref: read it for the branch that is currently checked out
  // (the server defaults to it, we pass it explicitly for clarity).
  // Guarded so re-opening the tab does not re-read an unchanged branch.
  const ciLoadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!state.ghReady || state.ghMessage) return
    const key = `${path}:${branch ?? ''}`
    if (ciLoadedFor.current === key) return
    ciLoadedFor.current = key
    void actions.loadCiStatus(path, branch ?? undefined)
  }, [path, branch, state.ghReady, state.ghMessage, actions])

  if (state.ghMessage) {
    return (
      <GitHubSetupPanel
        message={state.ghMessage}
        user={state.ghStatus?.user ?? null}
        remote={state.ghRemote}
      />
    )
  }

  if (!state.ghReady) {
    return (
      <EmptyState icon="🐙" title="GitHub is not available">
        The server could not confirm that the GitHub CLI (<span className="mono">gh</span>) is
        installed and authenticated.
      </EmptyState>
    )
  }

  const refresh = () => {
    ciLoadedFor.current = `${path}:${branch ?? ''}`
    void actions.loadCiStatus(path, branch ?? undefined)
  }

  return (
    <div className="branches">
      <section className="section-card">
        <header>
          <h3>Checks {ci ? `(${ci.checks.length})` : ''}</h3>
          {ci ? (
            <span
              className={`ci-roll-up ${ci.rollUp}`}
              title={`${ROLL_UP_LABEL[ci.rollUp]} — ${ci.checks.length} check${
                ci.checks.length === 1 ? '' : 's'
              }`}
            >
              {ROLL_UP_ICON[ci.rollUp]} {ROLL_UP_LABEL[ci.rollUp]}
            </span>
          ) : null}
          <span className="grow" />
          {loading ? <Spinner /> : null}
          <Button small variant="ghost" disabled={busy || loading} title="Reload checks" onClick={refresh}>
            Refresh
          </Button>
        </header>

        <div className="row" style={{ padding: '6px 12px', gap: 6, flexWrap: 'wrap' }}>
          <span className="chip" title="Branch the checks were read for">
            ⑂ {branch ?? 'no branch checked out'}
          </span>
          {state.ghRemote ? (
            <span className="chip mono">
              {state.ghRemote.owner}/{state.ghRemote.name}
            </span>
          ) : null}
          {ci?.headSha ? (
            <span className="sha-pill" title={`HEAD: ${ci.headSha}`}>
              {ci.headSha.slice(0, 7)}
            </span>
          ) : null}
        </div>

        {!ci ? (
          loading ? (
            <div className="hint" style={{ padding: '8px 12px' }}>
              Loading checks…
            </div>
          ) : (
            <EmptyState icon="🩺" title="No check data">
              Refresh to read the check runs and commit statuses for this branch.
            </EmptyState>
          )
        ) : ci.checks.length === 0 ? (
          <EmptyState icon="🩺" title="No checks">
            {branch
              ? `Nothing reported for ${branch} yet — checks appear once a CI provider runs.`
              : 'Nothing reported for this branch yet.'}
          </EmptyState>
        ) : (
          ci.checks.map((check) => (
            <div className="file-row check-row" key={`${check.kind}:${check.name}`}>
              <span className="check-name" title={`${check.kind} · ${check.name}`}>
                {check.name}
              </span>
              <span className={`check-badge ${badgeTone(check)}`}>{badgeLabel(check)}</span>
              {check.detailsUrl ? (
                <a
                  className="btn small ghost"
                  href={check.detailsUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={check.detailsUrl}
                >
                  Details
                </a>
              ) : (
                <span className="hint">no link</span>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  )
}
