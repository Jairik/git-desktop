/**
 * History tab: commit list from `log.list`, commit detail from
 * `log.commit` + `log.changedFiles`, and per-file diffs via
 * `diff.commit`. Also Undo (`commit.undo`) and Reset…
 * (`commit.resetTo`, soft/mixed/hard) behind confirmation.
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { methods } from '../api/client'
import type { ChangedFilesResult, Commit, Diff } from '../api/types'
import { useStore } from '../state/store'
import { ConfirmButton, EmptyState, fileStatusLabel, SelectField, Spinner } from './common'
import { DiffPane } from './DiffPane'
import { AgentReviewButton } from './AgentReviewButton'

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** One log row. Memoized so an unrelated store update doesn't re-render every row. */
const CommitRow = memo(function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: Commit
  selected: boolean
  onSelect: (sha: string) => void
}) {
  return (
    <div
      className={`commit-row${selected ? ' selected' : ''}`}
      onClick={() => onSelect(commit.sha)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(commit.sha)
        }
      }}
    >
      <div className="summary">{commit.summary}</div>
      <div className="meta">
        <span className="sha">{commit.shortSha}</span>
        <span>{commit.author.name}</span>
        <span>{formatDate(commit.author.date)}</span>
        {commit.tags.length > 0 ? (
          <span className="row" style={{ gap: 4 }}>
            {commit.tags.map((tag) => (
              <span className="tag-pill" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
        <span className="grow" />
        {/* The review button must not also select the row. */}
        <span
          className="row-actions"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <AgentReviewButton
            target={{ kind: 'commit', sha: commit.sha }}
            title={`Ask an agent to review ${commit.shortSha}`}
          />
        </span>
      </div>
    </div>
  )
})

export function HistoryTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const commits = state.commits

  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [detail, setDetail] = useState<Commit | null>(null)
  const [changed, setChanged] = useState<ChangedFilesResult | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [resetMode, setResetMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')

  const commitSignature = commits.map((c) => c.sha).join('|')

  useEffect(() => {
    setSelectedSha(null)
    setSelectedFile(null)
    setDetail(null)
    setChanged(null)
    setDiff(null)
  }, [path])

  // Keep a sensible selected commit as the log changes.
  useEffect(() => {
    setSelectedSha((prev) => {
      if (prev !== null && commits.some((c) => c.sha === prev)) return prev
      return commits.length > 0 ? commits[0].sha : null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitSignature])

  // Load commit detail + changed files.
  useEffect(() => {
    if (!selectedSha) return
    let cancelled = false
    methods
      .logCommit(path, selectedSha)
      .then((commit) => {
        if (!cancelled) setDetail(commit)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    methods
      .logChangedFiles(path, selectedSha)
      .then((result) => {
        if (!cancelled) {
          setChanged(result)
          setSelectedFile(result.files.length > 0 ? result.files[0].path : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChanged(null)
          setSelectedFile(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, selectedSha])

  // Load the diff for the selected file of the selected commit.
  const selectedChange = useMemo(
    () => changed?.files.find((f) => f.path === selectedFile) ?? null,
    [changed, selectedFile],
  )

  useEffect(() => {
    if (!selectedSha || !selectedChange) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    methods
      .diffCommit(path, { path: selectedChange.path }, selectedSha)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiff(null)
          setDiffError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, selectedSha, selectedChange])

  const undoCommit = async () => {
    if (!selectedSha) return
    await actions.runMutation('Undo commit', () => methods.commitUndo(path, selectedSha))
  }

  const resetCommit = async () => {
    if (!selectedSha) return
    await actions.runMutation('Reset', () => methods.commitResetTo(path, selectedSha, resetMode))
  }

  if (commits.length === 0) {
    return (
      <EmptyState icon="📜" title="No commits yet">
        This repository has no history (or no commits on the current branch).
      </EmptyState>
    )
  }

  return (
    <div className="history">
      <div className="history-toolbar">
        <strong>History</strong>
        <span className="hint">
          {commits.length} commit{commits.length === 1 ? '' : 's'} shown
        </span>
        <span className="spacer" />
        <SelectField
          label=""
          value={resetMode}
          onChange={(e) => setResetMode(e.target.value as 'soft' | 'mixed' | 'hard')}
          aria-label="Reset mode"
          style={{ width: 100 }}
        >
          <option value="soft">soft</option>
          <option value="mixed">mixed</option>
          <option value="hard">hard</option>
        </SelectField>
        <ConfirmButton
          small
          disabled={!selectedSha || state.busy !== null}
          question={`Reset HEAD to ${selectedSha?.slice(0, 7)} (${resetMode})?`}
          confirmLabel="Reset"
          onConfirm={() => void resetCommit()}
          title="Reset the current branch to the selected commit"
        >
          Reset…
        </ConfirmButton>
        <ConfirmButton
          small
          variant="danger"
          disabled={!selectedSha || state.busy !== null}
          question="Revert this commit?"
          confirmLabel="Undo"
          onConfirm={() => void undoCommit()}
          title="Revert this commit with git revert"
        >
          Undo
        </ConfirmButton>
        {state.loadingRepoData ? <Spinner /> : null}
      </div>

      <div className="commit-list">
        {commits.map((commit) => (
          <CommitRow
            key={commit.sha}
            commit={commit}
            selected={commit.sha === selectedSha}
            onSelect={setSelectedSha}
          />
        ))}
      </div>

      <section className="commit-detail-pane">
        {detail ? (
          <div className="commit-body">
            <div className="subject">{detail.summary}</div>
            <div className="who">
              {detail.author.name} &lt;{detail.author.email}&gt; authored on{' '}
              {formatDate(detail.author.date)}
            </div>
            <div className="row" style={{ marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
              <span className="sha-pill" title={detail.sha}>
                {detail.shortSha}
              </span>
              {detail.tags.map((tag) => (
                <span className="tag-pill" key={tag}>
                  {tag}
                </span>
              ))}
              {detail.parentSHAs.length > 1 ? <span className="chip">merge</span> : null}
            </div>
            {detail.body ? <div className="description">{detail.body}</div> : null}
          </div>
        ) : (
          <div className="commit-body muted">Select a commit…</div>
        )}

        <div className="commit-detail-files">
          <div className="file-list">
            {changed ? (
              changed.files.map((file) => (
                <div
                  key={file.id}
                  className={`file-row${file.path === selectedFile ? ' selected' : ''}`}
                  onClick={() => setSelectedFile(file.path)}
                  role="button"
                  tabIndex={0}
                  title={file.path}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedFile(file.path)
                    }
                  }}
                >
                  <span className="file-path">{file.path}</span>
                  <span className={`status-badge ${file.status.kind}`}>
                    {fileStatusLabel(file.status.kind)}
                  </span>
                </div>
              ))
            ) : (
              <div className="hint" style={{ padding: 8 }}>
                Loading changed files…
              </div>
            )}
            {changed ? (
              <div className="diff-stats" style={{ padding: '6px 8px' }}>
                <span className="added">+{changed.linesAdded}</span>{' '}
                <span className="deleted">−{changed.linesDeleted}</span>
              </div>
            ) : null}
          </div>

          <DiffPane
            title={selectedChange?.path}
            diff={diff}
            loading={diffLoading}
            error={diffError}
          />
        </div>
      </section>
    </div>
  )
}
