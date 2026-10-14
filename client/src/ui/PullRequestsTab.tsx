/**
 * Pull Requests tab: `pr.list` (with an open/closed/merged filter),
 * `pr.view` for the detail pane (body, review decision, comments) and
 * `pr.checkout` to switch the working tree to a PR's branch.
 *
 * Everything is served by the server's `gh` CLI, so when the server
 * cannot use it (`state.ghMessage` — missing/unauthenticated `gh`, or a
 * repo with no GitHub remote) the tab shows the setup panel instead.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PullRequest, PullRequestState } from '../api/types'
import { useStore } from '../state/store'
import { Button, EmptyState, Spinner } from './common'
import { GitHubSetupPanel } from './GitHubSetup'
import { AgentReviewButton } from './AgentReviewButton'

const PR_STATES: PullRequestState[] = ['open', 'closed', 'merged']

function stateLabel(state: PullRequestState): string {
  return state === 'open' ? 'Open' : state === 'closed' ? 'Closed' : 'Merged'
}

/** One PR row. Memoized so an unrelated store update doesn't re-render every row. */
const PullRequestRow = memo(function PullRequestRow({
  pr,
  selected,
  busy,
  onOpen,
}: {
  pr: PullRequest
  selected: boolean
  busy: boolean
  onOpen: (pr: PullRequest) => void
}) {
  return (
    <div
      className={`file-row pr-row${selected ? ' selected' : ''}`}
      onClick={() => onOpen(pr)}
      role="button"
      tabIndex={0}
      title={`#${pr.number} ${pr.title}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(pr)
        }
      }}
    >
      <span className="pr-number">#{pr.number}</span>
      <span className="pr-main">
        <span className="pr-title">{pr.title}</span>
        <span className="pr-meta">
          <span>{pr.author?.login ?? 'unknown author'}</span>
          <span className="mono">
            {pr.headRefName} → {pr.baseRefName}
          </span>
          <span className="diff-stats">
            <span className="added">+{pr.additions}</span>{' '}
            <span className="deleted">−{pr.deletions}</span>
          </span>
          <span>{pr.changedFiles} files</span>
        </span>
      </span>
      {pr.isDraft ? <span className="status-badge draft">Draft</span> : null}
      <span className={`status-badge ${pr.state}`}>{stateLabel(pr.state)}</span>
      {/* The review button must not also open the PR. */}
      <span className="row-actions" onClick={(e) => e.stopPropagation()} role="presentation">
        <AgentReviewButton
          target={{ kind: 'pr', number: pr.number }}
          disabled={busy}
          title={`Ask an agent to review PR #${pr.number}`}
        />
      </span>
    </div>
  )
})

export function PullRequestsTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const busy = state.busy !== null
  const prs = state.prs
  const prsState = state.prsState
  const selected = state.selectedPr
  const loading = state.prsLoading
  const [detailLoading, setDetailLoading] = useState(false)
  const detailLoadingRef = useRef(false)

  // `github.status` + `github.remote`: once per repo, when the tab is
  // opened (never on every repo switch).
  const ghLoadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (ghLoadedFor.current === path) return
    ghLoadedFor.current = path
    void actions.loadGitHubStatus(path)
  }, [path, actions])

  // The list itself, for the active state filter. Skipped while the
  // server can't talk to GitHub — the setup panel is showing instead.
  // Guarded so re-opening the tab does not re-read an unchanged list
  // (use "Refresh" to force it).
  const prsLoadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!state.ghReady || state.ghMessage) return
    const key = `${path}:${prsState}`
    if (prsLoadedFor.current === key) return
    prsLoadedFor.current = key
    void actions.loadPullRequests(path, prsState)
  }, [path, prsState, state.ghReady, state.ghMessage, actions])

  // Forget an in-flight detail request when the repo/filter changes.
  useEffect(() => {
    setDetailLoading(false)
  }, [path, prsState])

  // Open the detail pane. A useCallback (all hooks stay above the early
  // returns) so the memoized rows get a stable `onOpen` prop.
  const openPr = useCallback(
    async (pr: PullRequest) => {
      if (detailLoadingRef.current) return
      detailLoadingRef.current = true
      setDetailLoading(true)
      try {
        await actions.viewPullRequest(path, pr.number)
      } finally {
        detailLoadingRef.current = false
        setDetailLoading(false)
      }
    },
    [path, actions.viewPullRequest],
  )

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

  const checkout = async () => {
    if (!selected || busy) return
    await actions.checkoutPullRequest(path, selected.number)
  }

  const repoLabel = state.ghRemote
    ? `${state.ghRemote.owner}/${state.ghRemote.name}`
    : 'this repository'

  const refreshPullRequests = () => {
    prsLoadedFor.current = `${path}:${prsState}`
    void actions.loadPullRequests(path, prsState)
  }

  return (
    <div className="changes">
      <div className="changes-files-col">
        <div className="changes-files-header">
          <span className="title">Pull requests ({prs.length})</span>
          {loading ? <Spinner /> : null}
          <Button
            small
            variant="ghost"
            disabled={busy || loading}
            title="Reload pull requests"
            onClick={refreshPullRequests}
          >
            Refresh
          </Button>
        </div>

        <div className="prs-filter">
          {PR_STATES.map((option) => (
            <Button
              key={option}
              small
              variant={option === prsState ? 'default' : 'ghost'}
              disabled={busy || loading}
              title={`Show ${option} pull requests`}
              onClick={() => actions.setPullRequestState(option)}
            >
              {stateLabel(option)}
            </Button>
          ))}
          <span className="grow" />
          {state.ghRemote ? <span className="hint">{repoLabel}</span> : null}
        </div>

        <div className="file-list">
          {prs.length === 0 ? (
            <EmptyState icon="🔀" title={`No ${stateLabel(prsState).toLowerCase()} pull requests`}>
              {repoLabel} has no {stateLabel(prsState).toLowerCase()} pull requests.
            </EmptyState>
          ) : (
            prs.map((pr) => (
              <PullRequestRow
                key={pr.number}
                pr={pr}
                selected={selected?.number === pr.number}
                busy={busy}
                onOpen={openPr}
              />
            ))
          )}
        </div>
      </div>

      {selected ? (
        <section className="commit-detail-pane">
          <div className="diff-header">
            {detailLoading ? <Spinner /> : null}
            <span className="file-name">
              #{selected.number} {selected.title}
            </span>
            {selected.isDraft ? <span className="status-badge draft">Draft</span> : null}
            <span className={`status-badge ${selected.state}`}>{stateLabel(selected.state)}</span>
            <span className="spacer" />
            <Button
              small
              variant="primary"
              disabled={busy || detailLoading}
              busy={state.busy === 'Checkout PR'}
              title={`Check out #${selected.number} (${selected.headRefName})`}
              onClick={() => void checkout()}
            >
              Checkout
            </Button>
            <a
              className="btn small"
              href={selected.url}
              target="_blank"
              rel="noreferrer"
              title={selected.url}
            >
              Open on GitHub
            </a>
          </div>
          <div className="scroll-y">
            <div className="commit-body">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="chip">{selected.author?.login ?? 'unknown author'}</span>
                <span className="mono hint">
                  {selected.headRefName} → {selected.baseRefName}
                </span>
                <span className="diff-stats">
                  <span className="added">+{selected.additions}</span>{' '}
                  <span className="deleted">−{selected.deletions}</span>
                </span>
                <span className="hint">{selected.changedFiles} changed files</span>
                <span className="hint">{selected.comments} comments</span>
                {selected.reviewDecision ? (
                  <span className="chip" title="Review decision">
                    {selected.reviewDecision}
                  </span>
                ) : null}
                {selected.headSha ? (
                  <span className="sha-pill" title={selected.headSha}>
                    {selected.headSha.slice(0, 7)}
                  </span>
                ) : null}
              </div>
              <div className="description">
                {selected.body.trim().length > 0 ? (
                  selected.body
                ) : (
                  <span className="hint">No description provided.</span>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="commit-detail-pane">
          <div className="diff-header">
            <span className="file-name">No pull request selected</span>
          </div>
          <div className="scroll-y">
            <EmptyState icon="🔀" title="Select a pull request">
              Pick one from the list to read its description, review state and comments.
            </EmptyState>
          </div>
        </section>
      )}
    </div>
  )
}
