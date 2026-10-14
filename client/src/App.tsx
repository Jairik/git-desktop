/**
 * App shell: header (brand + server status), the server-down banner,
 * sidebar + main column (toolbar, tab bar, active view), and the
 * overlay progress cards / error toasts.
 *
 * To add a new view: add a tab to <Tabs/>, a case in <ActiveView/>
 * and a `src/ui/<View>Tab.tsx` component.
 */

import { BranchesTab } from './ui/BranchesTab'
import { ChangesTab, RepoNotices } from './ui/ChangesTab'
import { ChecksTab } from './ui/ChecksTab'
import { EmptyState, Spinner } from './ui/common'
import { HistoryTab } from './ui/HistoryTab'
import { ProgressBars } from './ui/ProgressBars'
import { ErrorToasts } from './ui/ErrorToasts'
import { PullRequestsTab } from './ui/PullRequestsTab'
import { ServerBanner } from './ui/ServerBanner'
import { Sidebar } from './ui/Sidebar'
import { StashTab } from './ui/StashTab'
import { TagsTab } from './ui/TagsTab'
import { Toolbar } from './ui/Toolbar'
import { useStore, type View } from './state/store'

export default function App() {
  return <Shell />
}

function Shell() {
  const { state } = useStore()
  const selected = state.repositories.find((r) => r.path === state.selectedRepoPath) ?? null

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">
          GitDaemon <small>web client</small>
        </span>
        <span className="server-chip" title="Server base URL (change with ?server=… or the banner)">
          <span className={`connection-dot ${state.serverUp ? 'up' : 'down'}`} />
          {state.serverUrl}
          {state.serverVersion ? ` · v${state.serverVersion}` : ''}
        </span>
        <span className="spacer" />
        {state.busy ? (
          <span className="busy-label">
            <Spinner />
            {state.busy}
          </span>
        ) : null}
      </header>

      <ServerBanner />

      <div className="app-body">
        <Sidebar />
        <main className="main-column">
          {selected ? (
            <>
              <Toolbar />
              <RepoNotices />
              <Tabs />
              <div className="tab-content">
                <ActiveView />
              </div>
            </>
          ) : (
            <EmptyState icon="🗃" title="No repository selected">
              {state.loadingRepositories
                ? 'Loading repositories…'
                : 'Add a local repository, create a new one, or clone from a URL using the sidebar.'}
            </EmptyState>
          )}
        </main>
      </div>

      <ProgressBars />
      <ErrorToasts />
    </div>
  )
}

function Tabs() {
  const { state, actions } = useStore()
  const fileCount = state.status?.workingDirectory.files.length ?? 0

  const tabs: Array<{ view: View; label: string; count?: number }> = [
    { view: 'changes', label: 'Changes', count: fileCount },
    { view: 'history', label: 'History', count: state.commits.length },
    { view: 'branches', label: 'Branches', count: state.branches.length },
    { view: 'prs', label: 'Pull Requests', count: state.prs.length },
    { view: 'checks', label: 'Checks / CI' },
    { view: 'stash', label: 'Stash', count: state.stashes.length },
    { view: 'tags', label: 'Tags', count: Object.keys(state.tags).length },
  ]

  return (
    <nav className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.view}
          role="tab"
          aria-selected={state.activeView === tab.view}
          className={state.activeView === tab.view ? 'active' : ''}
          onClick={() => actions.setView(tab.view)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? (
            <span className="count">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

function ActiveView() {
  const { state } = useStore()
  switch (state.activeView) {
    case 'changes':
      return <ChangesTab />
    case 'history':
      return <HistoryTab />
    case 'branches':
      return <BranchesTab />
    case 'prs':
      return <PullRequestsTab />
    case 'checks':
      return <ChecksTab />
    case 'stash':
      return <StashTab />
    case 'tags':
      return <TagsTab />
    default:
      return <ChangesTab />
  }
}
