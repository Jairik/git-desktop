/**
 * Branches tab: local + remote branches from `branch.list`, ahead/behind
 * via `branch.aheadBehind`, and the branch mutations (create / rename /
 * delete / checkout). Also the remotes section backed by `remote.list`,
 * `remote.add`, `remote.remove` and `remote.setUrl`.
 */

import { useEffect, useState } from 'react'
import { methods } from '../api/client'
import type { AheadBehind, Branch } from '../api/types'
import { useStore } from '../state/store'
import { Button, ConfirmButton, TextInput } from './common'

export function BranchesTab() {
  const { state } = useStore()
  const path = state.selectedRepoPath as string
  const currentBranch = state.status?.currentBranch ?? null

  const locals = state.branches.filter((b) => b.type === 'local')
  const remoteBranches = state.branches.filter((b) => b.type === 'remote')

  const [aheadBehind, setAheadBehind] = useState<Record<string, AheadBehind>>({})

  // Load ahead/behind for branches that track an upstream.
  const branchSignature = locals.map((b) => `${b.name}:${b.upstream ?? ''}`).join('|')
  useEffect(() => {
    let cancelled = false
    const targets = locals.filter((b) => b.upstream)
    if (targets.length === 0) {
      setAheadBehind({})
      return
    }
    void Promise.all(
      targets.map(async (branch) => {
        try {
          const result = await methods.branchAheadBehind(path, {
            name: branch.name,
            upstream: branch.upstream,
          })
          if (!cancelled) setAheadBehind((prev) => ({ ...prev, [branch.name]: result }))
        } catch {
          /* not fatal — just leave the counter blank */
        }
      }),
    )
    return () => {
      cancelled = true
    }
 }, [path, branchSignature]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="branches">
      <LocalBranchesSection
        branches={locals}
        currentBranch={currentBranch}
        aheadBehind={aheadBehind}
        path={path}
        busy={state.busy !== null}
      />

      <RemoteBranchesSection branches={remoteBranches} path={path} busy={state.busy !== null} />

      <RemotesSection busy={state.busy !== null} path={path} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Local branches                                                      */
/* ------------------------------------------------------------------ */

function LocalBranchesSection({
  branches,
  currentBranch,
  aheadBehind,
  path,
  busy,
}: {
  branches: Branch[]
  currentBranch: string | null
  aheadBehind: Record<string, AheadBehind>
  path: string
  busy: boolean
}) {
  const { actions } = useStore()
  const [name, setName] = useState('')
  const [startPoint, setStartPoint] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const create = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const ok = await actions.runMutation('Create branch', () =>
      methods.branchCreate(path, trimmed, startPoint.trim() || null),
    )
    if (ok !== null) {
      setName('')
      setStartPoint('')
    }
  }

  const checkout = async (branch: string) => {
    await actions.runMutation('Checkout', () => methods.branchCheckout(path, branch))
  }

  const rename = async (oldName: string, newName: string) => {
    const trimmed = newName.trim()
    if (trimmed.length === 0) return
    const ok = await actions.runMutation('Rename branch', () =>
      methods.branchRename(path, oldName, trimmed),
    )
    if (ok !== null) {
      setRenaming(null)
      setRenameValue('')
    }
  }

  const remove = async (branch: Branch) => {
    await actions.runMutation('Delete branch', () =>
      methods.branchDelete(path, { name: branch.name, type: branch.type }),
    )
  }

  return (
    <section className="section-card">
      <header>
        <h3>Local branches ({branches.length})</h3>
      </header>
      {branches.map((branch) => {
        const ab = aheadBehind[branch.name]
        const isCurrent = branch.name === currentBranch
        return (
          <div className={`branch-row${isCurrent ? ' current' : ''}`} key={branch.name}>
            <span className="name" title={branch.name}>
              {branch.name}
            </span>
            {isCurrent ? <span className="chip">current</span> : null}
            <span className="sha-pill">{branch.tip.sha.slice(0, 7)}</span>
            {branch.upstream ? (
              <span className="upstream" title={`tracks ${branch.upstream}`}>
                ⇅ {branch.upstream}
              </span>
            ) : (
              <span className="hint">no upstream</span>
            )}
            {ab ? (
              <span className="chip">
                <span className="up">↑ {ab.ahead}</span>
                <span className="down">↓ {ab.behind}</span>
              </span>
            ) : null}

            <span className="actions">
              {renaming === branch.name ? (
                <>
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    aria-label={`New name for ${branch.name}`}
                    style={{ width: 160 }}
                    autoFocus
                  />
                  <Button
                    small
                    variant="primary"
                    disabled={busy}
                    onClick={() => void rename(branch.name, renameValue)}
                  >
                    Save
                  </Button>
                  <Button small variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    small
                    variant="ghost"
                    disabled={busy || isCurrent}
                    onClick={() => void checkout(branch.name)}
                    title={isCurrent ? 'Already checked out' : `Checkout ${branch.name}`}
                  >
                    Checkout
                  </Button>
                  <Button
                    small
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setRenaming(branch.name)
                      setRenameValue(branch.name)
                    }}
                    title={`Rename ${branch.name}`}
                  >
                    Rename
                  </Button>
                  <ConfirmButton
                    small
                    variant="ghost"
                    disabled={busy}
                    question={isCurrent ? 'Delete the current branch?' : `Delete ${branch.name}?`}
                    confirmLabel="Delete"
                    onConfirm={() => void remove(branch)}
                    title={`Delete ${branch.name}`}
                  >
                    Delete
                  </ConfirmButton>
                </>
              )}
            </span>
          </div>
        )
      })}
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <TextInput
          placeholder="New branch name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New branch name"
        />
        <input
          type="text"
          placeholder="Start point (optional)"
          value={startPoint}
          onChange={(e) => setStartPoint(e.target.value)}
          aria-label="Start point"
        />
        <Button type="submit" small variant="primary" disabled={busy || !name.trim()}>
          Create branch
        </Button>
      </form>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Remote branches                                                     */
/* ------------------------------------------------------------------ */

function RemoteBranchesSection({
  branches,
  path,
  busy,
}: {
  branches: Branch[]
  path: string
  busy: boolean
}) {
  const { actions } = useStore()

  return (
    <section className="section-card">
      <header>
        <h3>Remote branches ({branches.length})</h3>
      </header>
      {branches.length === 0 ? (
        <div className="hint" style={{ padding: '8px 12px' }}>
          No remote branches — run Fetch to update.
        </div>
      ) : null}
      {branches.map((branch) => (
        <div className="branch-row" key={branch.name}>
          <span className="name" title={branch.name}>
            {branch.name}
          </span>
          <span className="sha-pill">{branch.tip.sha.slice(0, 7)}</span>
          <span className="actions">
            <ConfirmButton
              small
              variant="ghost"
              disabled={busy}
              question={`Delete ${branch.name} on its remote?`}
              confirmLabel="Delete"
              onConfirm={() =>
                void actions.runMutation('Delete remote branch', () =>
                  methods.branchDelete(path, { name: branch.name, type: 'remote' }),
                )
              }
              title={`Delete ${branch.name} on the remote`}
            >
              Delete
            </ConfirmButton>
          </span>
        </div>
      ))}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Remotes                                                             */
/* ------------------------------------------------------------------ */

function RemotesSection({ path, busy }: { path: string; busy: boolean }) {
  const { state, actions } = useStore()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')

  const add = async () => {
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    if (trimmedName.length === 0 || trimmedUrl.length === 0) return
    const ok = await actions.runMutation('Add remote', () =>
      methods.remoteAdd(path, trimmedName, trimmedUrl),
    )
    if (ok !== null) {
      setName('')
      setUrl('')
    }
  }

  const setRemoteUrl = async (remoteName: string, newUrl: string) => {
    const trimmed = newUrl.trim()
    if (trimmed.length === 0) return
    const ok = await actions.runMutation('Set remote URL', () =>
      methods.remoteSetUrl(path, remoteName, trimmed),
    )
    if (ok !== null) {
      setEditing(null)
      setEditUrl('')
    }
  }

  return (
    <section className="section-card">
      <header>
        <h3>Remotes ({state.remotes.length})</h3>
      </header>
      {state.remotes.length === 0 ? (
        <div className="hint" style={{ padding: '8px 12px' }}>
          No remotes configured.
        </div>
      ) : null}
      {state.remotes.map((remote) => (
        <div className="remote-row" key={remote.name}>
          <span className="name">{remote.name}</span>
          {editing === remote.name ? (
            <>
              <input
                type="text"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                aria-label={`New URL for remote ${remote.name}`}
                style={{ flex: 1 }}
                autoFocus
              />
              <Button
                small
                variant="primary"
                disabled={busy}
                onClick={() => void setRemoteUrl(remote.name, editUrl)}
              >
                Save
              </Button>
              <Button small variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="url" title={remote.url}>
                {remote.url}
              </span>
              <span className="actions">
                <Button
                  small
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEditing(remote.name)
                    setEditUrl(remote.url)
                  }}
                >
                  Edit URL
                </Button>
                <ConfirmButton
                  small
                  variant="ghost"
                  disabled={busy}
                  question={`Remove remote ${remote.name}?`}
                  confirmLabel="Remove"
                  onConfirm={() =>
                    void actions.runMutation('Remove remote', () =>
                      methods.remoteRemove(path, remote.name),
                    )
                  }
                >
                  Remove
                </ConfirmButton>
              </span>
            </>
          )}
        </div>
      ))}
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <TextInput
          placeholder="Name (e.g. origin)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Remote name"
        />
        <input
          type="text"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Remote URL"
        />
        <Button type="submit" small variant="primary" disabled={busy || !name.trim() || !url.trim()}>
          Add remote
        </Button>
      </form>
    </section>
  )
}
