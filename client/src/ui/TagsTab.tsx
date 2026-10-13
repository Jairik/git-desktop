/**
 * Tags tab: list tags via `tag.list` (name → sha), create annotated
 * tags with `tag.create` and delete them with `tag.delete`.
 */

import { useState } from 'react'
import { methods } from '../api/client'
import { useStore } from '../state/store'
import { Button, ConfirmButton, EmptyState, TextInput } from './common'

export function TagsTab() {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const busy = state.busy !== null

  const [name, setName] = useState('')
  const [target, setTarget] = useState('')

  const entries = Object.entries(state.tags)

  const createTag = async () => {
    const trimmedName = name.trim()
    if (trimmedName.length === 0) return
    // An empty target falls back to the current tip (HEAD).
    const targetSha = target.trim() || state.status?.currentTip
    if (!targetSha) return
    const ok = await actions.runMutation('Create tag', () =>
      methods.tagCreate(path, trimmedName, targetSha),
    )
    if (ok !== null) {
      setName('')
      setTarget('')
    }
  }

  return (
    <div className="branches">
      <section className="section-card">
        <header>
          <h3>Tags ({entries.length})</h3>
        </header>
        {entries.length === 0 ? (
          <EmptyState icon="🏷" title="No tags">
            Create a tag to mark a release or milestone.
          </EmptyState>
        ) : null}
        {entries.map(([tagName, sha]) => (
          <div className="tag-row" key={tagName}>
            <span className="name">{tagName}</span>
            <span className="sha-pill" title={sha}>
              {sha.slice(0, 7)}
            </span>
            <span className="actions">
              <ConfirmButton
                small
                variant="ghost"
                disabled={busy}
                question={`Delete tag ${tagName}?`}
                confirmLabel="Delete"
                onConfirm={() =>
                  void actions.runMutation('Delete tag', () => methods.tagDelete(path, tagName))
                }
              >
                Delete
              </ConfirmButton>
            </span>
          </div>
        ))}
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault()
            void createTag()
          }}
        >
          <TextInput
            placeholder="Tag name (e.g. v1.0.0)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Tag name"
          />
          <input
            type="text"
            placeholder="Target commit SHA (default: HEAD)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Target commit SHA"
          />
          <Button type="submit" small variant="primary" disabled={busy || !name.trim()}>
            Create tag
          </Button>
        </form>
      </section>
    </div>
  )
}
