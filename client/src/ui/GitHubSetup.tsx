/**
 * Setup panel shared by the Pull Requests and Checks tabs.
 *
 * `gh` runs on the machine running the SERVER, not in the browser, so
 * the most common reason these tabs have nothing to show is a server
 * without the GitHub CLI installed or authenticated. The store folds
 * `auth_required` / `gh_error` into `state.ghMessage`; when that
 * message is set both tabs render this panel instead of failing.
 */

import { useStore } from '../state/store'
import { Button, Spinner } from './common'

export function GitHubSetupPanel({
  message,
  user,
  remote,
}: {
  message: string
  user?: string | null
  remote?: { owner: string; name: string } | null
}) {
  const { state, actions } = useStore()
  const path = state.selectedRepoPath as string
  const busy = state.busy !== null

  const steps = [
    'Install the GitHub CLI on the machine running the server (https://cli.github.com).',
    'Run `gh auth login` on that machine — the browser cannot do it for the server.',
    'Make sure the repository has an `origin` remote pointing at github.com.',
  ]

  return (
    <div className="branches">
      <section className="section-card">
        <header>
          <h3>GitHub is not available</h3>
          <Button
            small
            variant="ghost"
            disabled={busy}
            onClick={() => void actions.loadGitHubStatus(path)}
            title="Re-check the GitHub CLI on the server"
          >
            Re-check
          </Button>
        </header>

        <div style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
          <strong style={{ color: 'var(--text-strong)' }}>{message}</strong>
          <div className="hint">
            Pull Requests and Checks are served through the <span className="mono">gh</span> CLI
            installed on the server, so they are set up there — not in this browser.
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {steps.map((step, index) => (
              <div className="hint" key={step}>
                {index + 1}. {step}
              </div>
            ))}
          </div>
          {user || remote ? (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {user ? <span className="chip">gh user: {user}</span> : null}
              {remote ? (
                <span className="chip mono">
                  {remote.owner}/{remote.name}
                </span>
              ) : null}
            </div>
          ) : null}
          {state.ghStatus === null && state.ghMessage === message ? (
            <div className="row">
              <Spinner />
              <span className="hint">Checking the server…</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
