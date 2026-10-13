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
  Branch,
  Commit,
  IStatusResult,
  ProgressPayload,
  Remote,
  Repository,
  StashEntry,
  TagMap,
} from '../api/types'

export type View = 'changes' | 'history' | 'branches' | 'stash' | 'tags'

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
      status?: IStatusResult | null
      branches?: Branch[]
      commits?: Commit[]
      remotes?: Remote[]
      tags?: TagMap
      stashes?: StashEntry[]
    }
  | { type: 'view'; view: View }
  | { type: 'busy'; label: string | null }
  | { type: 'progress'; event: ProgressEventName; data: ProgressPayload }
  | { type: 'progress-clear'; event: ProgressEventName }
  | { type: 'error'; error: AppError }
  | { type: 'dismiss-error'; id: number }

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
      }
    case 'repo-loading':
      return { ...state, loadingRepoData: true }
    case 'repo-data':
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

/** Turn any thrown value into an AppError (with git stderr when present). */
function toAppError(error: unknown): AppError {
  if (error instanceof RpcError) {
    const data = error.data as { stderr?: string; args?: unknown } | undefined
    const detail =
      data && typeof data === 'object'
        ? [data.stderr, data.args ? `args: ${JSON.stringify(data.args)}` : null]
            .filter(Boolean)
            .join('\n') || undefined
        : undefined
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
        dispatch({ type: 'repo-data', status })
      } catch (error) {
        dispatch({ type: 'repo-data', status: null })
        pushError(error)
      }

      try {
        const branches = await methods.branchList(repoPath)
        dispatch({ type: 'repo-data', branches })
      } catch {
        dispatch({ type: 'repo-data', branches: [] })
      }

      try {
        const commits = await methods.logList(repoPath)
        dispatch({ type: 'repo-data', commits })
      } catch {
        dispatch({ type: 'repo-data', commits: [] })
      }

      try {
        const remotes = await methods.remoteList(repoPath)
        dispatch({ type: 'repo-data', remotes })
      } catch {
        dispatch({ type: 'repo-data', remotes: [] })
      }

      try {
        const tags = await methods.tagList(repoPath)
        dispatch({ type: 'repo-data', tags })
      } catch {
        dispatch({ type: 'repo-data', tags: {} })
      }

      try {
        const stashes = await methods.stashList(repoPath)
        dispatch({ type: 'repo-data', stashes })
      } catch {
        dispatch({ type: 'repo-data', stashes: [] })
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
      runMutation,
      pushError,
      dismissError,
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
      runMutation,
      pushError,
      dismissError,
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
