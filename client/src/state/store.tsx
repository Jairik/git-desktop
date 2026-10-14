/**
 * Global client state.
 *
 * A tiny hand-rolled store: React Context + useReducer. It owns the
 * server connection status, the repository list, the selected repo's
 * data (status / branches / commits / remotes / tags / stashes), the
 * active view, a transient progress map for network operations, and a
 * toast-style error list.
 *
 * EVERY mutating RPC goes through {@link StoreActions.runMutation} (or
 * a dedicated action like cloneRepository) so the repo data is
 * refreshed afterwards — matching the contract's "re-issue status.get,
 * log.list, branch.list after any mutation" client behavior.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import {
  health,
  methods,
  resolveInitialServerUrl,
  RpcError,
  setServerUrl,
} from '../api/client'
import { onProgress, setProgressBaseUrl } from '../api/progress'
import type {
  AgentsConfig,
  Branch,
  CiStatus,
  Comment,
  Commit,
  DetectedAgent,
  GitHubRemote,
  GitHubStatus,
  IStatusResult,
  ProgressPayload,
  PullRequest,
  PullRequestDetail,
  PullRequestState,
  Remote,
  Repository,
  ReviewTarget,
  StashEntry,
  TagMap,
} from '../api/types'

export type View =
  | 'changes'
  | 'history'
  | 'branches'
  | 'stash'
  | 'tags'
  | 'prs'
  | 'checks'
  | 'agents'

/** Result of a successful `agent.commit_message`, split for the composer. */
export interface CommitMessageDraft {
  summary: string
  description: string
}

/** `agent.summarize_file` result as held in the store. */
export interface FileSummary {
  file: string
  text: string
  agent: string
}

/** `agent.review` result as held in the store. */
export interface ReviewResult {
  agent: string
  target: ReviewTarget
  summary: string | null
  output: string
}

/**
 * Split a free-form commit message into the composer's summary +
 * description on the first blank line.
 */
export function splitCommitMessage(message: string): CommitMessageDraft {
  const text = message.replace(/\r\n?/g, '\n').trim()
  if (text.length === 0) return { summary: '', description: '' }
  const gap = /\n[ \t]*\n/.exec(text)
  if (gap === null) return { summary: text, description: '' }
  return {
    summary: text.slice(0, gap.index).trim(),
    description: text.slice(gap.index + gap[0].length).trim(),
  }
}

/** Friendly "what to do next" message for agent RPC failures (else null). */
function agentSetupError(error: unknown): string | null {
  if (!(error instanceof RpcError)) return null
  switch (error.code) {
    case 'auth_required':
      return 'Install/authorize an AI agent (see Agents tab)'
    case 'not_found':
      return 'No agent configured for this task'
    case 'agent_error':
      return error.message || 'The agent CLI failed.'
    case 'unreachable':
      return 'Cannot reach the git server — start it to use AI agents.'
    default:
      return null
  }
}

/** Progress events pushed by the server on `/ws`. */
export type ProgressEventName =
  | 'clone.progress'
  | 'fetch.progress'
  | 'push.progress'
  | 'pull.progress'

export interface AppError {
  id: number
  message: string
  detail?: string
  code?: string
}

export interface AppState {
  serverUrl: string
  serverUp: boolean
  serverChecking: boolean
  serverVersion: string | null

  repositories: Repository[]
  loadingRepositories: boolean

  selectedRepoPath: string | null
  loadingRepoData: boolean
  status: IStatusResult | null
  branches: Branch[]
  commits: Commit[]
  remotes: Remote[]
  tags: TagMap
  stashes: StashEntry[]

  /**
   * GitHub state, driven by the server's `gh` CLI (`github.status` /
   * `github.remote`). `ghReady` = available && authenticated && the repo
   * has a GitHub remote; `ghMessage` is the friendly "what to do next"
   * hint shown by the Pull Requests / Checks tabs when it isn't ready.
   * Never loaded automatically on repo switch — the tabs ask for it.
   */
  ghStatus: GitHubStatus | null
  ghRemote: GitHubRemote | null
  ghReady: boolean
  ghMessage: string | null

  prs: PullRequest[]
  prsLoading: boolean
  /** Active `pr.list` state filter. */
  prsState: PullRequestState
  selectedPr: PullRequestDetail | null

  ci: CiStatus | null
  ciLoading: boolean

  /**
   * Local agents (`agent.list` / `agent.config.get`). Scanned lazily —
   * once per selected repo (see `ensureAgents`), never on every tab
   * toggle, and re-scanned only on "Rescan". `agentsBusy` is the label of
   * the in-flight agent/review/comment operation (they are slow), and
   * `agentsMessage` is the friendly "install/authorize an agent" hint.
   */
  detectedAgents: DetectedAgent[]
  agentsLoading: boolean
  agentsConfig: AgentsConfig | null
  agentsConfigLoading: boolean
  agentsBusy: string | null
  agentsMessage: string | null
  /** Repo path agents were loaded for (drives the once-per-repo scan). */
  agentsLoadedFor: string | null

  /** `agent.commit_message` for the commit composer. */
  commitMessageBusy: boolean

  /** `agent.summarize_file` for the previewed file. */
  fileSummary: FileSummary | null
  fileSummaryBusy: boolean

  /** `agent.review` for the last reviewed target. */
  review: ReviewResult | null
  reviewBusy: boolean

  /** Per-file comments; `commentsBusy` holds the comment id in flight. */
  comments: Record<string, Comment[]>
  commentsBusy: string | null

  activeView: View
  /** Label of the in-flight mutation (e.g. 'Pulling…'), or null. */
  busy: string | null

  /** Latest `{phase,value,detail}` per progress event name. */
  progress: Partial<Record<ProgressEventName, ProgressPayload>>

  errors: AppError[]
}

const initialState: AppState = {
  serverUrl: resolveInitialServerUrl(),
  serverUp: false,
  serverChecking: true,
  serverVersion: null,
  repositories: [],
  loadingRepositories: false,
  selectedRepoPath: null,
  loadingRepoData: false,
  status: null,
  branches: [],
  commits: [],
  remotes: [],
  tags: {},
  stashes: [],
  ghStatus: null,
  ghRemote: null,
  ghReady: false,
  ghMessage: null,
  prs: [],
  prsLoading: false,
  prsState: 'open',
  selectedPr: null,
  ci: null,
  ciLoading: false,
  detectedAgents: [],
  agentsLoading: false,
  agentsConfig: null,
  agentsConfigLoading: false,
  agentsBusy: null,
  agentsMessage: null,
  agentsLoadedFor: null,
  commitMessageBusy: false,
  fileSummary: null,
  fileSummaryBusy: false,
  review: null,
  reviewBusy: false,
  comments: {},
  commentsBusy: null,
  activeView: 'changes',
  busy: null,
  progress: {},
  errors: [],
}

type Action =
  | { type: 'server-checking' }
  | { type: 'server-status'; up: boolean; version?: string | null }
  | { type: 'server-url'; url: string }
  | { type: 'repos-loading' }
  | { type: 'repos-loaded'; repositories: Repository[] }
  | { type: 'repo-selected'; path: string | null }
  | { type: 'repo-loading' }
  | {
      type: 'repo-data'
      /** The repo this data belongs to; a mismatch is dropped (stale refresh). */
      path: string
      status?: IStatusResult | null
      branches?: Branch[]
      commits?: Commit[]
      remotes?: Remote[]
      tags?: TagMap
      stashes?: StashEntry[]
    }
  | {
      type: 'github-status'
      status: GitHubStatus | null
      remote: GitHubRemote | null
      /** Explicit message; omitted → derived from status/remote. */
      message?: string | null
    }
  | { type: 'github-message'; message: string | null }
  | { type: 'prs-loading' }
  | { type: 'prs-loaded'; prs: PullRequest[] }
  | { type: 'prs-state'; prsState: PullRequestState }
  | { type: 'pr-selected'; pr: PullRequestDetail | null }
  | { type: 'ci-loading' }
  | { type: 'ci-loaded'; ci: CiStatus | null }
  | { type: 'agents-loading' }
  | { type: 'agents-loaded'; agents: DetectedAgent[]; config: AgentsConfig | null }
  | { type: 'agents-config-loading' }
  | { type: 'agents-config-loaded'; config: AgentsConfig | null }
  | { type: 'agents-busy'; label: string | null }
  | { type: 'agents-message'; message: string | null }
  | { type: 'agents-loaded-for'; path: string | null }
  | { type: 'commit-message-busy'; busy: boolean }
  | { type: 'file-summary'; summary: FileSummary | null }
  | { type: 'file-summary-busy'; busy: boolean }
  | { type: 'review'; review: ReviewResult | null }
  | { type: 'review-busy'; busy: boolean }
  | { type: 'comments-loading' }
  | { type: 'comments-loaded'; file: string; comments: Comment[] }
  | { type: 'comments-busy'; id: string | null }
  | { type: 'view'; view: View }
  | { type: 'busy'; label: string | null }
  | { type: 'progress'; event: ProgressEventName; data: ProgressPayload }
  | { type: 'progress-clear'; event: ProgressEventName }
  | { type: 'error'; error: AppError }
  | { type: 'dismiss-error'; id: number }

/**
 * Next step for the user when the server's `gh` CLI can't serve GitHub
 * data — drives the setup panel on the Pull Requests / Checks tabs.
 * Returns `null` when everything needed is in place.
 */
function githubSetupMessage(
  status: GitHubStatus | null,
  remote: GitHubRemote | null,
): string | null {
  if (!status) return null
  if (!status.available) {
    return 'Install the GitHub CLI (`gh`) on the machine running the server.'
  }
  if (!status.authenticated) {
    return 'Run `gh auth login` on the server machine.'
  }
  if (!remote) {
    return 'This repository has no GitHub remote — `origin` must point at github.com.'
  }
  return null
}

/** Friendly message for the GitHub-specific RPC failures (else `null`). */
function githubSetupError(error: unknown): string | null {
  if (!(error instanceof RpcError)) return null
  if (error.code === 'auth_required') {
    return 'The server cannot use the GitHub CLI (`gh`) right now — install `gh` on the machine running the server and run `gh auth login` there.'
  }
  if (error.code === 'gh_error') {
    return `The GitHub CLI on the server failed: ${error.message}`
  }
  return null
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server-checking':
      return { ...state, serverChecking: true }
    case 'server-status':
      return {
        ...state,
        serverChecking: false,
        serverUp: action.up,
        serverVersion: action.version ?? state.serverVersion,
      }
    case 'server-url':
      return {
        ...state,
        serverUrl: action.url,
        serverUp: false,
        serverChecking: true,
        serverVersion: null,
      }
    case 'repos-loading':
      return { ...state, loadingRepositories: true }
    case 'repos-loaded':
      return { ...state, loadingRepositories: false, repositories: action.repositories }
    case 'repo-selected':
      return {
        ...state,
        selectedRepoPath: action.path,
        status: null,
        branches: [],
        commits: [],
        remotes: [],
        tags: {},
        stashes: [],
        // GitHub data is per-repo and only loaded when a GitHub tab is
        // opened — drop whatever the previous repo had.
        ghStatus: null,
        ghRemote: null,
        ghReady: false,
        ghMessage: null,
        prs: [],
        prsLoading: false,
        selectedPr: null,
        ci: null,
        ciLoading: false,
        // Agent data is per-repo too: drop the previous repo's scan so
        // the next repo gets its own (lazy) load.
        detectedAgents: [],
        agentsLoading: false,
        agentsConfig: null,
        agentsConfigLoading: false,
        agentsBusy: null,
        agentsMessage: null,
        agentsLoadedFor: null,
        commitMessageBusy: false,
        fileSummary: null,
        fileSummaryBusy: false,
        review: null,
        reviewBusy: false,
        comments: {},
        commentsBusy: null,
      }
    case 'repo-loading':
      return { ...state, loadingRepoData: true }
    case 'repo-data':
      // A slow refresh for a previously-selected repo can resolve after the
      // user has switched to another one; never paint its data under the repo
      // now selected.
      if (action.path !== state.selectedRepoPath) return state
      return {
        ...state,
        loadingRepoData: false,
        status: action.status !== undefined ? action.status : state.status,
        branches: action.branches !== undefined ? action.branches : state.branches,
        commits: action.commits !== undefined ? action.commits : state.commits,
        remotes: action.remotes !== undefined ? action.remotes : state.remotes,
        tags: action.tags !== undefined ? action.tags : state.tags,
        stashes: action.stashes !== undefined ? action.stashes : state.stashes,
      }
    case 'github-status': {
      const ghReady =
        action.status !== null && action.status.available && action.status.authenticated
      const message =
        action.message !== undefined ? action.message : githubSetupMessage(action.status, action.remote)
      return {
        ...state,
        ghStatus: action.status,
        ghRemote: action.remote,
        ghReady,
        ghMessage: message,
      }
    }
    case 'github-message':
      return { ...state, ghMessage: action.message }
    case 'prs-loading':
      return { ...state, prsLoading: true }
    case 'prs-loaded':
      return { ...state, prsLoading: false, prs: action.prs }
    case 'prs-state':
      return { ...state, prsState: action.prsState, selectedPr: null }
    case 'pr-selected':
      return { ...state, selectedPr: action.pr }
    case 'ci-loading':
      return { ...state, ciLoading: true }
    case 'ci-loaded':
      return { ...state, ciLoading: false, ci: action.ci }
    case 'agents-loading':
      return { ...state, agentsLoading: true, agentsConfigLoading: true, agentsMessage: null }
    case 'agents-loaded':
      return {
        ...state,
        agentsLoading: false,
        agentsConfigLoading: false,
        detectedAgents: action.agents,
        agentsConfig: action.config,
      }
    case 'agents-config-loading':
      return { ...state, agentsConfigLoading: true }
    case 'agents-config-loaded':
      return { ...state, agentsConfigLoading: false, agentsConfig: action.config }
    case 'agents-busy':
      return { ...state, agentsBusy: action.label }
    case 'agents-message':
      return { ...state, agentsMessage: action.message }
    case 'agents-loaded-for':
      return { ...state, agentsLoadedFor: action.path }
    case 'commit-message-busy':
      return { ...state, commitMessageBusy: action.busy }
    case 'file-summary':
      return { ...state, fileSummary: action.summary }
    case 'file-summary-busy':
      return { ...state, fileSummaryBusy: action.busy }
    case 'review':
      return { ...state, review: action.review }
    case 'review-busy':
      return { ...state, reviewBusy: action.busy }
    case 'comments-loading':
      return { ...state, commentsBusy: state.commentsBusy ?? 'load' }
    case 'comments-loaded':
      return {
        ...state,
        comments: { ...state.comments, [action.file]: action.comments },
        commentsBusy: state.commentsBusy === 'load' ? null : state.commentsBusy,
      }
    case 'comments-busy':
      return { ...state, commentsBusy: action.id }
    case 'view':
      return { ...state, activeView: action.view }
    case 'busy':
      return { ...state, busy: action.label }
    case 'progress':
      return { ...state, progress: { ...state.progress, [action.event]: action.data } }
    case 'progress-clear': {
      const next = { ...state.progress }
      delete next[action.event]
      return { ...state, progress: next }
    }
    case 'error':
      return { ...state, errors: [...state.errors, action.error].slice(-6) }
    case 'dismiss-error':
      return { ...state, errors: state.errors.filter((e) => e.id !== action.id) }
    default:
      return state
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export interface StoreActions {
  /** Resolve the URL, connect progress, check /health, load repos. */
  initApp: () => Promise<void>
  retryConnection: () => Promise<void>
  /** Point the client at a different server URL and reconnect. */
  setServerUrlAndReconnect: (url: string) => Promise<void>
  checkServer: () => Promise<boolean>
  loadRepositories: () => Promise<void>
  selectRepository: (path: string) => Promise<void>
  refreshRepo: (path?: string) => Promise<void>

  addLocalRepository: (path: string, alias?: string) => Promise<Repository | null>
  createNewRepository: (path: string) => Promise<Repository | null>
  cloneRepository: (url: string, path: string) => Promise<Repository | null>
  closeRepository: (path: string) => Promise<void>
  setAlias: (path: string, alias: string) => Promise<void>

  setView: (view: View) => void
  /** Remove a progress card from the transient progress map. */
  dismissProgress: (event: ProgressEventName) => void

  /**
   * Load `github.status` + `github.remote` for a repo. Failures of the
   * GitHub-specific codes (`auth_required` / `gh_error`) are folded into
   * `ghMessage`; transport failures surface as a toast and leave the
   * GitHub state empty. Called when a GitHub tab is opened.
   */
  loadGitHubStatus: (path: string) => Promise<void>
  /** Load `pr.list` for a repo + state filter. */
  loadPullRequests: (path: string, state?: PullRequestState) => Promise<void>
  /** Load `pr.view` into `selectedPr` (null when the PR is gone). */
  viewPullRequest: (path: string, number: number) => Promise<void>
  /** `pr.checkout` as a mutation (refreshes the repo) then reload CI. */
  checkoutPullRequest: (path: string, number: number) => Promise<void>
  /** Load `ci.status` (defaults to the repo's current branch). */
  loadCiStatus: (path: string, ref?: string) => Promise<void>
  /** Set the active `pr.list` filter (drops the selected PR). */
  setPullRequestState: (state: PullRequestState) => void

  /**
   * Local agents. Agent operations run an LLM CLI on the server, so they
   * are slow: every action here exposes an explicit busy flag.
   * Failures of `auth_required` / `not_found` / `agent_error` fold into
   * `agentsMessage` (the tab shows the hint) and still surface a toast.
   */

  /** True when at least one detected agent is available. */
  agentsReady: boolean
  /**
   * Load `agent.list` + `agent.config.get` for a repo — but only once:
   * tab toggles reuse the scan, switching repos starts a new one.
   * Pass `force` (Rescan) to re-read regardless.
   */
  ensureAgents: (path: string, force?: boolean) => Promise<void>
  /** Re-scan the agent CLIs and re-read the config. */
  loadAgents: () => Promise<void>
  /** Re-read the effective agents config (without rescanning). */
  loadAgentsConfig: () => Promise<void>
  /** Persist the agents config, then re-read it. `true` when it stuck. */
  saveAgentsConfig: (config: AgentsConfig) => Promise<boolean>
  /** `agent.commit_message`, split into the composer's two fields. */
  generateCommitMessage: () => Promise<CommitMessageDraft | null>
  /** `agent.summarize_file` for a (previewed) file. */
  summarizeFile: (file: string, ref?: string) => Promise<void>
  /** `agent.review` on a file / commit / PR. */
  runReview: (target: ReviewTarget) => Promise<void>
  /** Clear the file summary / review result panels. */
  clearAgentResults: () => void
  /** `comment.list` for one file. */
  loadComments: (file: string) => Promise<void>
  /** `comment.create` for a file (optional line + side). */
  createComment: (input: {
    file: string
    line?: number | null
    side?: 'old' | 'new' | null
    body: string
  }) => Promise<Comment | null>
  /** `comment.delete`. */
  deleteComment: (id: string) => Promise<void>
  /** `comment.send` — runs the `comment` task, fills reply + agent. */
  sendComment: (id: string) => Promise<Comment | null>

  /**
   * Run a mutating RPC: sets the busy label, catches errors into the
   * toast list, clears progress, and refreshes the selected repo.
   * Returns the RPC result, or `null` when it failed.
   */
  runMutation: <T>(
    label: string,
    fn: () => Promise<T>,
    progressEvent?: ProgressEventName,
  ) => Promise<T | null>

  pushError: (error: unknown) => void
  dismissError: (id: number) => void
}

const StoreContext = createContext<{ state: AppState; actions: StoreActions } | null>(null)

let nextErrorId = 1

/** Turn any thrown value into an AppError (with git/agent stderr when it adds
 * something the message doesn't already say). */
function toAppError(error: unknown): AppError {
  if (error instanceof RpcError) {
    // For git/gh errors the message already carries the tool's stderr (see
    // `ApiError::message`), so only attach stderr when it is something new
    // (agent failures) — otherwise the toast would print it twice. The raw
    // argv that used to be appended is debug noise for a user-facing toast.
    const data = error.data as { stderr?: string } | undefined
    const stderr =
      data && typeof data === 'object' && typeof data.stderr === 'string'
        ? data.stderr.trim()
        : ''
    const detail = stderr && stderr !== error.message ? stderr : undefined
    return { id: nextErrorId++, message: error.message, detail, code: error.code }
  }
  return {
    id: nextErrorId++,
    message: error instanceof Error ? error.message : String(error),
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const didInit = useRef(false)

  const pushError = useCallback((error: unknown) => {
    const appError = toAppError(error)
    dispatch({ type: 'error', error: appError })
    // Auto-dismiss non-transport errors after a while.
    window.setTimeout(() => dispatch({ type: 'dismiss-error', id: appError.id }), 12_000)
  }, [])

  const dismissError = useCallback((id: number) => {
    dispatch({ type: 'dismiss-error', id })
  }, [])

  /* ------------------------------------------------------------------ */
  /* Server connection                                                  */
  /* ------------------------------------------------------------------ */

  const checkServer = useCallback(async (): Promise<boolean> => {
    dispatch({ type: 'server-checking' })
    try {
      const result = await health()
      dispatch({ type: 'server-status', up: Boolean(result.ok), version: result.version })
      return Boolean(result.ok)
    } catch {
      dispatch({ type: 'server-status', up: false, version: null })
      return false
    }
  }, [])

  const loadRepositories = useCallback(async () => {
    dispatch({ type: 'repos-loading' })
    try {
      const repositories = await methods.repoList()
      dispatch({ type: 'repos-loaded', repositories })
    } catch (error) {
      dispatch({ type: 'repos-loaded', repositories: [] })
      pushError(error)
    }
  }, [pushError])

  /** (Re-)load all data for a repo: status, branches, log, remotes, tags, stashes. */
  const refreshRepo = useCallback(
    async (path?: string) => {
      const repoPath = path ?? stateRef.current.selectedRepoPath
      if (!repoPath) return
      dispatch({ type: 'repo-loading' })

      // The status drives most of the UI; surface its failures loudly.
      // Auxiliary loads (e.g. log.list on a repo with no commits yet)
      // degrade quietly to empty lists.
      try {
        const status = await methods.statusGet(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, status })
      } catch (error) {
        dispatch({ type: 'repo-data', path: repoPath, status: null })
        pushError(error)
      }

      try {
        const branches = await methods.branchList(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, branches })
      } catch {
        dispatch({ type: 'repo-data', path: repoPath, branches: [] })
      }

      try {
        const commits = await methods.logList(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, commits })
      } catch {
        dispatch({ type: 'repo-data', path: repoPath, commits: [] })
      }

      try {
        const remotes = await methods.remoteList(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, remotes })
      } catch {
        dispatch({ type: 'repo-data', path: repoPath, remotes: [] })
      }

      try {
        const tags = await methods.tagList(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, tags })
      } catch {
        dispatch({ type: 'repo-data', path: repoPath, tags: {} })
      }

      try {
        const stashes = await methods.stashList(repoPath)
        dispatch({ type: 'repo-data', path: repoPath, stashes })
      } catch {
        dispatch({ type: 'repo-data', path: repoPath, stashes: [] })
      }
    },
    [pushError],
  )

  const selectRepository = useCallback(
    async (path: string) => {
      dispatch({ type: 'repo-selected', path })
      stateRef.current = { ...stateRef.current, selectedRepoPath: path }
      await refreshRepo(path)
    },
    [refreshRepo],
  )

  /* ------------------------------------------------------------------ */
  /* Mutations                                                          */
  /* ------------------------------------------------------------------ */

  const runMutation = useCallback(
    async <T,>(
      label: string,
      fn: () => Promise<T>,
      progressEvent?: ProgressEventName,
    ): Promise<T | null> => {
      dispatch({ type: 'busy', label })
      try {
        const result = await fn()
        if (progressEvent) dispatch({ type: 'progress-clear', event: progressEvent })
        const path = stateRef.current.selectedRepoPath
        if (path) await refreshRepo(path)
        return result
      } catch (error) {
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'busy', label: null })
      }
    },
    [pushError, refreshRepo],
  )

  const addLocalRepository = useCallback(
    async (path: string, alias?: string): Promise<Repository | null> => {
      dispatch({ type: 'busy', label: 'Adding repository…' })
      try {
        const repo = await methods.repoOpen(path, alias)
        await loadRepositories()
        return repo
      } catch (error) {
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'busy', label: null })
      }
    },
    [loadRepositories, pushError],
  )

  const createNewRepository = useCallback(
    async (path: string): Promise<Repository | null> => {
      dispatch({ type: 'busy', label: 'Creating repository…' })
      try {
        const repo = await methods.repoInit(path)
        await loadRepositories()
        await selectRepository(repo.path)
        return repo
      } catch (error) {
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'busy', label: null })
      }
    },
    [loadRepositories, pushError, selectRepository],
  )

  const cloneRepository = useCallback(
    async (url: string, path: string): Promise<Repository | null> => {
      dispatch({ type: 'busy', label: 'Cloning…' })
      try {
        const repo = await methods.clone(url, path)
        dispatch({ type: 'progress-clear', event: 'clone.progress' })
        await loadRepositories()
        await selectRepository(repo.path)
        return repo
      } catch (error) {
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'busy', label: null })
      }
    },
    [loadRepositories, pushError, selectRepository],
  )

  const closeRepository = useCallback(
    async (path: string) => {
      try {
        await methods.repoClose(path)
      } catch (error) {
        pushError(error)
        return
      }
      await loadRepositories()
      if (stateRef.current.selectedRepoPath === path) {
        dispatch({ type: 'repo-selected', path: null })
      }
    },
    [loadRepositories, pushError],
  )

  const setAlias = useCallback(
    async (path: string, alias: string) => {
      try {
        await methods.repoSetAlias(path, alias)
      } catch (error) {
        pushError(error)
        return
      }
      await loadRepositories()
    },
    [loadRepositories, pushError],
  )

  const setView = useCallback((view: View) => {
    dispatch({ type: 'view', view })
  }, [])

  const dismissProgress = useCallback((event: ProgressEventName) => {
    dispatch({ type: 'progress-clear', event })
  }, [])

  /* ------------------------------------------------------------------ */
  /* GitHub (via the server's `gh` CLI)                                  */
  /* ------------------------------------------------------------------ */

  const loadGitHubStatus = useCallback(
    async (path: string) => {
      let status: GitHubStatus | null = null
      try {
        status = await methods.githubStatus()
      } catch (error) {
        const friendly = githubSetupError(error)
        if (friendly) {
          dispatch({ type: 'github-message', message: friendly })
          return
        }
        // Transport/server failure: leave the GitHub state empty so the
        // tabs show a neutral "not available" state (the server-down
        // banner already explains what happened).
        dispatch({ type: 'github-status', status: null, remote: null, message: null })
        pushError(error)
        return
      }

      let remote: GitHubRemote | null = null
      try {
        remote = await methods.githubRemote(path)
      } catch (error) {
        const friendly = githubSetupError(error)
        // `not_found` ("origin is not a GitHub remote") is already
        // explained by the derived message — no toast on top of it.
        const quiet = error instanceof RpcError && error.code === 'not_found'
        dispatch({ type: 'github-status', status, remote: null, message: friendly })
        if (!friendly && !quiet) pushError(error)
        return
      }

      dispatch({ type: 'github-status', status, remote })
    },
    [pushError],
  )

  const loadPullRequests = useCallback(
    async (path: string, prsState: PullRequestState = 'open') => {
      dispatch({ type: 'prs-loading' })
      try {
        const prs = await methods.prList({ path, state: prsState })
        dispatch({ type: 'prs-loaded', prs })
      } catch (error) {
        dispatch({ type: 'prs-loaded', prs: [] })
        const friendly = githubSetupError(error)
        if (friendly) dispatch({ type: 'github-message', message: friendly })
        else pushError(error)
      }
    },
    [pushError],
  )

  const viewPullRequest = useCallback(
    async (path: string, number: number) => {
      try {
        const pr = await methods.prView({ path, number })
        dispatch({ type: 'pr-selected', pr })
      } catch (error) {
        dispatch({ type: 'pr-selected', pr: null })
        const friendly = githubSetupError(error)
        if (friendly) dispatch({ type: 'github-message', message: friendly })
        else pushError(error)
      }
    },
    [pushError],
  )

  const loadCiStatus = useCallback(
    async (path: string, ref?: string) => {
      dispatch({ type: 'ci-loading' })
      try {
        const ci = await methods.ciStatus({ path, ...(ref ? { ref } : {}) })
        dispatch({ type: 'ci-loaded', ci })
      } catch (error) {
        dispatch({ type: 'ci-loaded', ci: null })
        const friendly = githubSetupError(error)
        if (friendly) dispatch({ type: 'github-message', message: friendly })
        else pushError(error)
      }
    },
    [pushError],
  )

  // `pr.checkout` switches the working tree, so it goes through
  // runMutation (which refreshes the repo) — the CI roll-up is then
  // re-read for the branch that is now checked out.
  const checkoutPullRequest = useCallback(
    async (path: string, number: number) => {
      const ok = await runMutation('Checkout PR', () => methods.prCheckout({ path, number }))
      if (ok === null) return
      const branch = stateRef.current.status?.currentBranch
      await loadCiStatus(path, branch ?? undefined)
      await loadPullRequests(path, stateRef.current.prsState)
      // Re-read the detail so its head SHA / review state match the
      // branch that is now checked out.
      await viewPullRequest(path, number)
    },
    [loadCiStatus, loadPullRequests, runMutation, viewPullRequest],
  )

  const setPullRequestState = useCallback((prsState: PullRequestState) => {
    dispatch({ type: 'prs-state', prsState })
  }, [])

  /* ------------------------------------------------------------------ */
  /* Local agents, reviews & comments                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Scan the agent CLIs + read the effective config for a repo. The scan
   * is cached per repo (and by the server until `agent.config.set`), so
   * repeat calls — e.g. toggling into the Agents tab — are free.
   */
  const loadAgentData = useCallback(
    async (path: string, force: boolean) => {
      if (!force) {
        if (stateRef.current.agentsLoadedFor === path) return
        if (stateRef.current.agentsLoading) return
      }
      // Claim the repo up-front so concurrent mounts don't double-scan.
      stateRef.current = { ...stateRef.current, agentsLoadedFor: path }
      dispatch({ type: 'agents-loaded-for', path })
      dispatch({ type: 'agents-loading' })
      // The scan probes each agent's `--version`, so it is not instant —
      // label it (the same label drives the Agents tab's spinner).
      dispatch({ type: 'agents-busy', label: 'Scanning agents…' })
      try {
        const [scan, config] = await Promise.all([
          methods.agentList(),
          methods.agentConfigGet(),
        ])
        dispatch({ type: 'agents-loaded', agents: scan.agents, config })
      } catch (error) {
        dispatch({ type: 'agents-loaded', agents: [], config: null })
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        // Transport failures are already explained by the server banner.
        if (!(error instanceof RpcError && error.code === 'unreachable')) pushError(error)
      } finally {
        dispatch({ type: 'agents-busy', label: null })
      }
    },
    [pushError],
  )

  const ensureAgents = useCallback(
    async (path: string, force: boolean = false) => {
      await loadAgentData(path, force)
    },
    [loadAgentData],
  )

  /** Rescan + re-read the config for the currently selected repo. */
  const loadAgents = useCallback(async () => {
    const path = stateRef.current.selectedRepoPath
    if (!path) return
    await loadAgentData(path, true)
  }, [loadAgentData])

  const loadAgentsConfig = useCallback(async () => {
    dispatch({ type: 'agents-config-loading' })
    try {
      const config = await methods.agentConfigGet()
      dispatch({ type: 'agents-config-loaded', config })
    } catch (error) {
      dispatch({ type: 'agents-config-loaded', config: null })
      dispatch({ type: 'agents-message', message: agentSetupError(error) })
      if (!(error instanceof RpcError && error.code === 'unreachable')) pushError(error)
    }
  }, [pushError])

  const saveAgentsConfig = useCallback(
    async (config: AgentsConfig): Promise<boolean> => {
      dispatch({ type: 'agents-message', message: null })
      dispatch({ type: 'agents-busy', label: 'Saving agents config…' })
      try {
        await methods.agentConfigSet(config)
        // `agent.config.set` clears the server's scan cache, so re-read
        // the effective config (not the whole scan) to confirm the save.
        await loadAgentsConfig()
        return true
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
        return false
      } finally {
        dispatch({ type: 'agents-busy', label: null })
      }
    },
    [loadAgentsConfig, pushError],
  )

  const generateCommitMessage = useCallback(async (): Promise<CommitMessageDraft | null> => {
    const path = stateRef.current.selectedRepoPath
    if (!path) return null
    dispatch({ type: 'commit-message-busy', busy: true })
    try {
      const result = await methods.agentCommitMessage({ path, staged: true })
      return splitCommitMessage(result.message)
    } catch (error) {
      dispatch({ type: 'agents-message', message: agentSetupError(error) })
      pushError(error)
      return null
    } finally {
      dispatch({ type: 'commit-message-busy', busy: false })
    }
  }, [pushError])

  const summarizeFile = useCallback(
    async (file: string, ref?: string) => {
      const path = stateRef.current.selectedRepoPath
      if (!path || file.length === 0) return
      dispatch({ type: 'file-summary-busy', busy: true })
      try {
        const result = await methods.agentSummarizeFile({
          path,
          file,
          ...(ref ? { ref } : {}),
        })
        dispatch({
          type: 'file-summary',
          summary: { file, text: result.summary, agent: result.agent },
        })
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
      } finally {
        dispatch({ type: 'file-summary-busy', busy: false })
      }
    },
    [pushError],
  )

  const runReview = useCallback(
    async (target: ReviewTarget) => {
      const path = stateRef.current.selectedRepoPath
      if (!path) return
      dispatch({ type: 'review-busy', busy: true })
      try {
        const review = await methods.agentReview({ path, target })
        dispatch({
          type: 'review',
          review: {
            agent: review.agent,
            target: review.target,
            summary: review.summary,
            output: review.output,
          },
        })
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
      } finally {
        dispatch({ type: 'review-busy', busy: false })
      }
    },
    [pushError],
  )

  const clearAgentResults = useCallback(() => {
    dispatch({ type: 'file-summary', summary: null })
    dispatch({ type: 'review', review: null })
  }, [])

  const loadComments = useCallback(
    async (file: string) => {
      const path = stateRef.current.selectedRepoPath
      if (!path || file.length === 0) return
      dispatch({ type: 'comments-loading' })
      try {
        const comments = await methods.commentList({ path, file })
        dispatch({ type: 'comments-loaded', file, comments })
      } catch (error) {
        dispatch({ type: 'comments-loaded', file, comments: [] })
        pushError(error)
      }
    },
    [pushError],
  )

  const createComment = useCallback(
    async (input: {
      file: string
      line?: number | null
      side?: 'old' | 'new' | null
      body: string
    }): Promise<Comment | null> => {
      const path = stateRef.current.selectedRepoPath
      if (!path) return null
      const body = input.body.trim()
      if (body.length === 0) return null
      dispatch({ type: 'comments-busy', id: 'create' })
      try {
        const comment = await methods.commentCreate({
          path,
          file: input.file,
          line: input.line ?? null,
          side: input.side ?? null,
          body,
        })
        // Re-read the file so ordering/statuses match the daemon's.
        const comments = await methods.commentList({ path, file: input.file })
        dispatch({ type: 'comments-loaded', file: input.file, comments })
        return comment
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'comments-busy', id: null })
      }
    },
    [pushError],
  )

  const deleteComment = useCallback(
    async (id: string) => {
      const path = stateRef.current.selectedRepoPath
      if (!path) return
      const file =
        Object.keys(stateRef.current.comments).find((key) =>
          stateRef.current.comments[key].some((comment) => comment.id === id),
        ) ?? null
      dispatch({ type: 'comments-busy', id })
      try {
        await methods.commentDelete({ path, id })
        if (file) await loadComments(file)
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
      } finally {
        dispatch({ type: 'comments-busy', id: null })
      }
    },
    [loadComments, pushError],
  )

  const sendComment = useCallback(
    async (id: string): Promise<Comment | null> => {
      const path = stateRef.current.selectedRepoPath
      if (!path) return null
      dispatch({ type: 'comments-busy', id })
      try {
        const updated = await methods.commentSend({ path, id })
        if (updated.file) await loadComments(updated.file)
        return updated
      } catch (error) {
        dispatch({ type: 'agents-message', message: agentSetupError(error) })
        pushError(error)
        return null
      } finally {
        dispatch({ type: 'comments-busy', id: null })
      }
    },
    [loadComments, pushError],
  )

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */

  const initApp = useCallback(async () => {
    setServerUrl(stateRef.current.serverUrl)
    setProgressBaseUrl(stateRef.current.serverUrl)

    // Fan progress frames into the store. The subscription lives for
    // the lifetime of the app (a fresh socket connection per server
    // URL reuses these listeners), so we don't tear it down.
    onProgress((frame) => {
      const data = frame.data
      if (!data || typeof data !== 'object') return
      const payload = data as ProgressPayload
      if (typeof payload.phase !== 'string' || typeof payload.value !== 'number') return
      dispatch({
        type: 'progress',
        event: frame.event as ProgressEventName,
        data: { phase: payload.phase, value: payload.value, detail: payload.detail },
      })
    })

    const up = await checkServer()
    if (up) {
      await loadRepositories()
      // Select the most recently added repo for convenience.
      const repos = stateRef.current.repositories
      if (repos.length > 0 && !stateRef.current.selectedRepoPath) {
        await selectRepository(repos[repos.length - 1].path)
      }
    }
  }, [checkServer, loadRepositories, selectRepository])

  useEffect(() => {
    // React StrictMode mounts effects twice in dev — only init once.
    if (didInit.current) return
    didInit.current = true
    void initApp()
    // initApp is deliberately stable; eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initApp])

  const retryConnection = useCallback(async () => {
    dispatch({ type: 'agents-loaded-for', path: null })
    const up = await checkServer()
    if (up) {
      await loadRepositories()
      const repos = stateRef.current.repositories
      if (repos.length > 0 && !stateRef.current.selectedRepoPath) {
        await selectRepository(repos[repos.length - 1].path)
      }
    }
  }, [checkServer, loadRepositories, selectRepository])

  const setServerUrlAndReconnect = useCallback(
    async (url: string) => {
      const clean = url.trim().replace(/\/+$/, '')
      if (clean.length === 0) return
      setServerUrl(clean)
      setProgressBaseUrl(clean)
      dispatch({ type: 'server-url', url: clean })
      dispatch({ type: 'agents-loaded-for', path: null })
      const up = await checkServer()
      if (up) {
        await loadRepositories()
        const repos = stateRef.current.repositories
        if (repos.length > 0 && !stateRef.current.selectedRepoPath) {
          await selectRepository(repos[repos.length - 1].path)
        }
      }
    },
    [checkServer, loadRepositories, selectRepository],
  )

  const actions = useMemo<StoreActions>(
    () => ({
      initApp,
      retryConnection,
      setServerUrlAndReconnect,
      checkServer,
      loadRepositories,
      selectRepository,
      refreshRepo,
      addLocalRepository,
      createNewRepository,
      cloneRepository,
      closeRepository,
      setAlias,
      setView,
      dismissProgress,
      loadGitHubStatus,
      loadPullRequests,
      viewPullRequest,
      checkoutPullRequest,
      loadCiStatus,
      setPullRequestState,
      ensureAgents,
      loadAgents,
      loadAgentsConfig,
      saveAgentsConfig,
      generateCommitMessage,
      summarizeFile,
      runReview,
      clearAgentResults,
      loadComments,
      createComment,
      deleteComment,
      sendComment,
      runMutation,
      pushError,
      dismissError,
      // Derived: at least one scanned agent binary is usable.
      agentsReady: state.detectedAgents.some((agent) => agent.available),
    }),
    [
      initApp,
      retryConnection,
      setServerUrlAndReconnect,
      checkServer,
      loadRepositories,
      selectRepository,
      refreshRepo,
      addLocalRepository,
      createNewRepository,
      cloneRepository,
      closeRepository,
      setAlias,
      setView,
      dismissProgress,
      loadGitHubStatus,
      loadPullRequests,
      viewPullRequest,
      checkoutPullRequest,
      loadCiStatus,
      setPullRequestState,
      ensureAgents,
      loadAgents,
      loadAgentsConfig,
      saveAgentsConfig,
      generateCommitMessage,
      summarizeFile,
      runReview,
      clearAgentResults,
      loadComments,
      createComment,
      deleteComment,
      sendComment,
      runMutation,
      pushError,
      dismissError,
      state.detectedAgents,
    ],
  )

  const value = useMemo(() => ({ state, actions }), [state, actions])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/** Access the global store. Must be used inside <StoreProvider>. */
export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) {
    throw new Error('useStore must be used within <StoreProvider>')
  }
  return ctx
}

/** Split `origin/branch` style upstream refs into remote + branch parts. */
export function splitUpstream(upstream: string): { remote: string; branch: string } | null {
  const slash = upstream.indexOf('/')
  if (slash <= 0 || slash === upstream.length - 1) return null
  return {
    remote: upstream.slice(0, slash),
    branch: upstream.slice(slash + 1),
  }
}
