/**
 * Left sidebar: the repository list plus the three "open a repo"
 * entry points — Add Local (`repo.open`), Create New (`repo.init`) and
 * Clone (`clone`, subscribes to `clone.progress`).
 */

import { useState } from 'react'
import { useStore } from '../state/store'
import { Button, Spinner } from './common'

/** Last path segment, used when a repo has no alias. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

type Panel = 'none' | 'add' | 'create' | 'clone'

export function Sidebar() {
  const { state, actions } = useStore()
  const [panel, setPanel] = useState<Panel>('none')

  const toggle = (next: Panel) => setPanel((prev) => (prev === next ? 'none' : next))

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <h3>Add repository</h3>
        <div className="btn-group" role="group" aria-label="Add repository">
          <Button small onClick={() => toggle('add')} aria-pressed={panel === 'add'}>
            Add local…
          </Button>
          <Button small onClick={() => toggle('create')} aria-pressed={panel === 'create'}>
            New…
          </Button>
          <Button small onClick={() => toggle('clone')} aria-pressed={panel === 'clone'}>
            Clone…
          </Button>
        </div>

        {panel === 'add' ? <AddLocalForm onDone={() => setPanel('none')} /> : null}
        {panel === 'create' ? <CreateRepoForm onDone={() => setPanel('none')} /> : null}
        {panel === 'clone' ? <CloneForm onDone={() => setPanel('none')} /> : null}
      </div>

      <div className="repo-section">
        <h3>
          Repositories <span className="count">({state.repositories.length})</span>
          {state.loadingRepositories ? <Spinner /> : null}
        </h3>
        <div className="repo-list">
          {state.repositories.length === 0 ? (
            <div className="hint" style={{ padding: '4px 8px' }}>
              No repositories yet. Add a local folder, create a new one, or clone from a
              URL.
            </div>
          ) : null}
          {state.repositories.map((repo) => {
            const selected = repo.path === state.selectedRepoPath
            return (
              <div
                key={repo.id}
                className={`repo-row${selected ? ' selected' : ''}`}
                onClick={() => void actions.selectRepository(repo.path)}
                role="button"
                tabIndex={0}
                title={repo.path}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void actions.selectRepository(repo.path)
                  }
                }}
              >
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="repo-name">
                    {repo.alias || basename(repo.path)}
                    {repo.missing ? (
                      <span className="missing-flag" title="Path is missing on disk">
                        {' '}
                        ⚠
                      </span>
                    ) : null}
                  </div>
                  <div className="repo-path">{repo.path}</div>
                </div>
                {selected && state.loadingRepoData ? <Spinner /> : null}
                <Button
                  className="ghost small"
                  title={`Close ${repo.path}`}
                  aria-label={`Close ${repo.path}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void actions.closeRepository(repo.path)
                  }}
                >
                  ✕
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

/** Path input + optional alias → `repo.open`. */
function AddLocalForm({ onDone }: { onDone: () => void }) {
  const { actions } = useStore()
  const [path, setPath] = useState('')
  const [alias, setAlias] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (path.trim().length === 0) return
    setBusy(true)
    try {
      const repo = await actions.addLocalRepository(path.trim(), alias.trim() || undefined)
      if (repo) await actions.selectRepository(repo.path)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="form-row"
      style={{ flexDirection: 'column', alignItems: 'stretch' }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        type="text"
        placeholder="/absolute/path/to/repo"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="Repository path"
        autoFocus
      />
      <input
        type="text"
        placeholder="Alias (optional)"
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        aria-label="Repository alias"
      />
      <div className="row">
        <Button type="submit" small variant="primary" busy={busy} disabled={!path.trim()}>
          Add
        </Button>
        <Button type="button" small variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** Path input → `repo.init` (git init, default branch main). */
function CreateRepoForm({ onDone }: { onDone: () => void }) {
  const { actions } = useStore()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (path.trim().length === 0) return
    setBusy(true)
    try {
      await actions.createNewRepository(path.trim())
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="form-row"
      style={{ flexDirection: 'column', alignItems: 'stretch' }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        type="text"
        placeholder="/absolute/path/for/new/repo"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="New repository path"
        autoFocus
      />
      <div className="row">
        <Button type="submit" small variant="primary" busy={busy} disabled={!path.trim()}>
          Create
        </Button>
        <Button type="button" small variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** URL + path → `clone`. Progress arrives on the `clone.progress` event. */
function CloneForm({ onDone }: { onDone: () => void }) {
  const { state, actions } = useStore()
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')

  const cloneProgress = state.progress['clone.progress']

  return (
    <form
      className="form-row"
      style={{ flexDirection: 'column', alignItems: 'stretch' }}
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim() && path.trim()) void actions.cloneRepository(url.trim(), path.trim())
      }}
    >
      <input
        type="text"
        placeholder="https://github.com/owner/repo.git"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Clone URL"
        autoFocus
      />
      <input
        type="text"
        placeholder="/absolute/destination/path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="Clone destination path"
      />
      <div className="row">
        <Button
          type="submit"
          small
          variant="primary"
          busy={state.busy === 'Cloning…'}
          disabled={!url.trim() || !path.trim()}
        >
          Clone
        </Button>
        <Button type="button" small variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {cloneProgress ? (
        <div className="hint">
          {cloneProgress.phase} {Math.round(cloneProgress.value)}
          %{cloneProgress.detail ? ` — ${cloneProgress.detail}` : ''}
        </div>
      ) : null}
    </form>
  )
}
