/**
 * Changes tab: working-directory file list + commit box + diff pane.
 *
 * Staging model (v1): git staging is whole-file, so a file is either
 * "included" (checked → `status.stage`) or excluded (unchecked →
 * `status.unstage`). Files that appear in `status.get` are the
 * working-directory changes; checked files are passed to
 * `commit.create`'s `files` param (staged-then-committed server-side).
 * Excluded ids are kept locally so unchecking survives refreshes.
 */

import { useEffect, useMemo, useState } from 'react'
import { methods } from '../api/client'
import type { Diff, FileChange } from '../api/types'
import { useStore } from '../state/store'
import { Button, ConfirmButton, EmptyState, fileStatusLabel, Spinner } from './common'
import { DiffPane } from './DiffPane'

export function ChangesTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const status = state.status
  const files = status?.workingDirectory.files ?? []
  const busy = state.busy !== null

  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')

  // Changes when the file set (paths + statuses) changes.
  const fileSignature = files.map((f) => `${f.id}:${f.status.kind}`).join('|')

  // Reset transient UI state when switching repos.
  useEffect(() => {
    setExcluded(new Set())
    setSelectedFile(null)
    setDiff(null)
    setSummary('')
    setDescription('')
  }, [path])

  // Keep a sensible selected file as the list changes.
  useEffect(() => {
    setSelectedFile((prev) => {
      if (prev !== null && files.some((f) => f.id === prev)) return prev
      return files.length > 0 ? files[0].id : null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSignature])

  const selectedChange = useMemo(
    () => files.find((f) => f.id === selectedFile) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, selectedFile],
  )

  // Load the diff for the selected file.
  useEffect(() => {
    if (!selectedChange) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    methods
      .diffWorkingDirectory(path, { path: selectedChange.path, status: selectedChange.status })
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
  }, [path, selectedChange])

  const includedPaths = files.filter((f) => !excluded.has(f.id)).map((f) => f.path)
  const canCommit = summary.trim().length > 0

  /* ------------------------------ actions ------------------------- */

  const commit = async () => {
    if (busy) return
    const trimmed = summary.trim()
    if (trimmed.length === 0) return
    const ok = await actions.runMutation('Commit', () =>
      methods.commitCreate(
        path,
        { summary: trimmed, description: description.trim() },
        includedPaths.length > 0 ? includedPaths : undefined,
      ),
    )
    if (ok !== null) {
      setSummary('')
      setDescription('')
      setExcluded(new Set())
    }
  }

  const setInclusion = async (file: FileChange, include: boolean) => {
    if (busy) return
    setExcluded((prev) => {
      const next = new Set(prev)
      if (include) next.delete(file.id)
      else next.add(file.id)
      return next
    })
    await actions.runMutation(include ? 'Stage' : 'Unstage', () =>
      include
        ? methods.statusStage(path, [file.path])
        : methods.statusUnstage(path, [file.path]),
    )
  }

  const stageAll = async () => {
    if (busy) return
    const targets = files.map((f) => f.path)
    if (targets.length === 0) return
    const ok = await actions.runMutation('Stage all', () => methods.statusStage(path, targets))
    if (ok !== null) setExcluded(new Set())
  }

  const unstageAll = async () => {
    if (busy) return
    const ok = await actions.runMutation('Unstage all', () => methods.statusUnstageAll(path))
    if (ok !== null) setExcluded(new Set())
  }

  const discard = async (targets: string[]) => {
    if (busy) return
    if (targets.length === 0) return
    await actions.runMutation('Discard', () =>
      methods.statusDiscard(path, targets, true, false),
    )
  }

  /* ------------------------------- render ------------------------- */

  if (files.length === 0 && status !== null && !state.loadingRepoData) {
    return (
      <div className="changes">
        <div className="changes-files-col">
          <div className="changes-files-header">
            <span className="title">Working directory</span>
          </div>
          <EmptyState icon="✅" title="No changes">
            The working directory is clean.
          </EmptyState>
        </div>
        <DiffPane diff={null} loading={false} />
      </div>
    )
  }

  return (
    <div className="changes">
      <div className="changes-files-col">
        <div className="changes-files-header">
          <span className="title">
            Changes <span className="count">({files.length})</span>
          </span>
          <Button small variant="ghost" onClick={() => void stageAll()} disabled={files.length === 0 || busy}>
            Stage all
          </Button>
          <Button small variant="ghost" onClick={() => void unstageAll()} disabled={files.length === 0 || busy}>
            Unstage all
          </Button>
        </div>

        <div className="file-list">
          {files.map((file) => {
            const checked = !excluded.has(file.id)
            return (
              <div
                key={file.id}
                className={`file-row${file.id === selectedFile ? ' selected' : ''}`}
                onClick={() => setSelectedFile(file.id)}
                role="button"
                tabIndex={0}
                title={file.path}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedFile(file.id)
                  }
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  aria-label={`Include ${file.path}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void setInclusion(file, e.target.checked)}
                />
                <span className="file-path">{file.path}</span>
                <span className={`status-badge ${file.status.kind}`}>
                  {fileStatusLabel(file.status.kind)}
                </span>
                <span className="file-actions">
                  <ConfirmButton
                    small
                    variant="ghost"
                    disabled={busy}
                    title={`Discard changes in ${file.path}`}
                    aria-label={`Discard ${file.path}`}
                    question="Discard?"
                    confirmLabel="Discard"
                    onConfirm={() => void discard([file.path])}
                  >
                    🗑
                  </ConfirmButton>
                </span>
              </div>
            )
          })}
        </div>

        <div className="commit-box">
          <div className="commit-inputs">
            <input
              type="text"
              placeholder="Summary (required)"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void commit()
                }
              }}
              aria-label="Commit summary"
            />
            <textarea
              rows={3}
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Commit description"
            />
          </div>
          <div className="commit-actions">
            <Button
              variant="primary"
              disabled={!canCommit || busy}
              busy={state.busy === 'Commit'}
              onClick={() => void commit()}
            >
              Commit
            </Button>
            <span className="hint">
              {includedPaths.length} of {files.length} file{files.length === 1 ? '' : 's'} selected
            </span>
            <span className="grow" />
            {selectedChange ? (
              <ConfirmButton
                small
                disabled={busy}
                title={`Discard changes in ${selectedChange.path}`}
                question={`Discard ${selectedChange.path}?`}
                confirmLabel="Discard"
                onConfirm={() => void discard([selectedChange.path])}
              >
                Discard selected
              </ConfirmButton>
            ) : null}
          </div>
        </div>
      </div>

      <DiffPane
        title={selectedChange?.path}
        diff={diff}
        loading={diffLoading}
        error={diffError}
      />
    </div>
  )
}

/** Small "repo state" notice strip (merge / cherry-pick / conflicts). */
export function RepoNotices() {
  const { state } = useStore()
  const status = state.status
  if (!status) return null

  const notices: string[] = []
  if (status.mergeHeadFound) notices.push('Merge in progress')
  if (status.isCherryPickingHeadFound) notices.push('Cherry-pick in progress')
  if (status.squashMsgFound) notices.push('Squash message pending')
  if (status.doConflictedFilesExist) notices.push('Conflicted files exist')

  if (notices.length === 0) return null
  return (
    <div className="row" style={{ padding: '4px 12px', gap: 6 }}>
      {notices.map((notice) => (
        <span className="chip" key={notice} style={{ color: 'var(--orange)' }}>
          ⚠ {notice}
        </span>
      ))}
      {state.loadingRepoData ? <Spinner /> : null}
    </div>
  )
}
