/**
 * Stash tab (v1 — minimal): list stashes via `stash.list`, pop/drop
 * them (`stash.pop` / `stash.drop`), and stash the current working
 * directory with `stash.create`.
 */

import { useState } from 'react'
import { methods } from '../api/client'
import { useStore } from '../state/store'
import { Button, ConfirmButton, EmptyState, TextInput } from './common'

export function StashTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const [branchName, setBranchName] = useState('')
  const busy = state.busy !== null

  const createStash = async () => {
    const trimmed = branchName.trim()
    if (trimmed.length === 0) return
    const ok = await actions.runMutation('Stash changes', () =>
      methods.stashCreate(path, trimmed, true),
    )
    if (ok !== null) setBranchName('')
  }

  if (state.stashes.length === 0) {
    return (
      <div className="branches">
        <section className="section-card">
          <header>
            <h3>Stashes</h3>
          </header>
          <EmptyState icon="📦" title="No stashes">
            Stash changes to set them aside without committing.
          </EmptyState>
          <CreateStashForm
            branchName={branchName}
            setBranchName={setBranchName}
            busy={busy}
            onSubmit={createStash}
          />
        </section>
      </div>
    )
  }

  return (
    <div className="branches">
      <section className="section-card">
        <header>
          <h3>Stashes ({state.stashes.length})</h3>
        </header>
        {state.stashes.map((stash) => (
          <div className="stash-row" key={stash.stashSha}>
            <span className="sha-pill" title={stash.stashSha}>
              {stash.stashSha.slice(0, 7)}
            </span>
            <span className="message truncate" title={stash.name}>
              {stash.name}
            </span>
            <span className="chip">{stash.branchName}</span>
            <span className="actions">
              <Button
                small
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void actions.runMutation('Pop stash', () =>
                    methods.stashPop(path, stash.stashSha),
                  )
                }
              >
                Pop
              </Button>
              <ConfirmButton
                small
                variant="ghost"
                disabled={busy}
                question="Drop this stash?"
                confirmLabel="Drop"
                onConfirm={() =>
                  void actions.runMutation('Drop stash', () =>
                    methods.stashDrop(path, stash.stashSha),
                  )
                }
              >
                Drop
              </ConfirmButton>
            </span>
          </div>
        ))}
        <CreateStashForm
          branchName={branchName}
          setBranchName={setBranchName}
          busy={busy}
          onSubmit={createStash}
        />
      </section>
    </div>
  )
}

function CreateStashForm({
  branchName,
  setBranchName,
  busy,
  onSubmit,
}: {
  branchName: string
  setBranchName: (value: string) => void
  busy: boolean
  onSubmit: () => Promise<void>
}) {
  return (
    <form
      className="form-row"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit()
      }}
    >
      <TextInput
        placeholder="Branch name for the stash"
        value={branchName}
        onChange={(e) => setBranchName(e.target.value)}
        aria-label="Stash branch name"
      />
      <Button type="submit" small variant="primary" disabled={busy || !branchName.trim()}>
        Stash changes
      </Button>
    </form>
  )
}
