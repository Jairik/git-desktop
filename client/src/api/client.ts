/**
 * RPC client for the gitdaemon server.
 *
 * Transport: JSON-RPC-style `POST <base>/rpc` with body
 * `{ id, method, params }` and either `{ id, ok: true, result }` or
 * `{ id, ok: false, error: { code, message, data? } }`.
 *
 * Base URL resolution order (per the contract):
 *   `?server=` query param → `window.GITDAEMON_URL` →
 *   `localStorage.gitdaemon_url` → `http://127.0.0.1:4789`
 */

import type {
  AheadBehind,
  Branch,
  ChangedFilesResult,
  Commit,
  CommitIdentity,
  CommitOneLine,
  Diff,
  FileChange,
  HealthResult,
  IStatusResult,
  Remote,
  Repository,
  RepositoryType,
  StashEntry,
  TagMap,
} from './types'

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4789'

/** Error codes used by the server contract. */
export type RpcErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'git_error'
  | 'io_error'
  | 'conflict'
  /* client-only codes */
  | 'unreachable'
  | 'http_error'
  | 'bad_response'
  | 'unknown'

/** Thrown for every failed RPC — either `ok: false` or transport issues. */
export class RpcError extends Error {
  readonly code: RpcErrorCode
  readonly data?: unknown

  constructor(code: RpcErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/* ------------------------------------------------------------------ */
/* Base URL handling                                                   */
/* ------------------------------------------------------------------ */

let serverUrl = DEFAULT_SERVER_URL
let nextId = 1

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '')

export function getServerUrl(): string {
  return serverUrl
}

/** Resolve the effective server URL using the contract's priority order. */
export function resolveInitialServerUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_SERVER_URL
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('server')
    if (fromQuery && fromQuery.trim().length > 0) {
      return stripTrailingSlash(fromQuery.trim())
    }
  } catch {
    /* window may be unavailable in odd environments — fall through */
  }
  const fromGlobal = (window as unknown as { GITDAEMON_URL?: unknown }).GITDAEMON_URL
  if (typeof fromGlobal === 'string' && fromGlobal.trim().length > 0) {
    return stripTrailingSlash(fromGlobal.trim())
  }
  try {
    const stored = window.localStorage.getItem('gitdaemon_url')
    if (stored && stored.trim().length > 0) {
      return stripTrailingSlash(stored.trim())
    }
  } catch {
    /* localStorage may be disabled — fall through to default */
  }
  return DEFAULT_SERVER_URL
}

/** Set the active server URL (also persisted for the next session). */
export function setServerUrl(url: string): void {
  const clean = stripTrailingSlash(url.trim())
  if (clean.length === 0) return
  serverUrl = clean
  try {
    window.localStorage.setItem('gitdaemon_url', clean)
  } catch {
    /* ignore storage failures */
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * Call an RPC method and unwrap `result`.
 * Throws {@link RpcError} on `ok: false` and on transport failures
 * (code `unreachable` when the server cannot be reached at all).
 */
export async function rpc<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = nextId++

  let response: Response
  try {
    response = await fetch(`${serverUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, method, params }),
    })
  } catch (cause) {
    throw new RpcError(
      'unreachable',
      `Cannot reach the git server at ${serverUrl}`,
      { cause: String(cause) },
    )
  }

  if (!response.ok) {
    throw new RpcError(
      'http_error',
      `${method} failed: HTTP ${response.status} ${response.statusText}`.trim(),
      { status: response.status },
    )
  }

  const body: unknown = await response.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    throw new RpcError('bad_response', `${method}: server returned non-JSON body`)
  }
  const envelope = body as { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string; data?: unknown } }
  if (typeof envelope.ok !== 'boolean') {
    throw new RpcError('bad_response', `${method}: malformed response envelope`)
  }

  if (envelope.ok) {
    return envelope.result as T
  }
  const code = (envelope.error?.code ?? 'unknown') as RpcErrorCode
  const message = envelope.error?.message ?? 'Unknown error'
  throw new RpcError(code, message, envelope.error?.data)
}

/** `GET /health` → `{ ok, version }`. Throws RpcError when unreachable. */
export async function health(): Promise<HealthResult> {
  let response: Response
  try {
    response = await fetch(`${serverUrl}/health`)
  } catch (cause) {
    throw new RpcError(
      'unreachable',
      `Cannot reach the git server at ${serverUrl}`,
      { cause: String(cause) },
    )
  }
  if (!response.ok) {
    throw new RpcError('http_error', `health check failed: HTTP ${response.status}`, {
      status: response.status,
    })
  }
  return (await response.json()) as HealthResult
}

/* ------------------------------------------------------------------ */
/* Typed methods — the one place method names are defined.             */
/* To wire a new RPC method, add it here and use it from the store.   */
/* ------------------------------------------------------------------ */

export const methods = {
  /* Repository */
  repoList: () => rpc<Repository[]>('repo.list', {}),
  repoOpen: (path: string, alias?: string) =>
    rpc<Repository>('repo.open', { path, ...(alias ? { alias } : {}) }),
  repoClose: (path: string) => rpc<{}>('repo.close', { path }),
  repoType: (path: string) => rpc<RepositoryType>('repo.type', { path }),
  repoSetAlias: (path: string, alias: string) =>
    rpc<Repository>('repo.setAlias', { path, alias }),
  repoInit: (path: string) => rpc<Repository>('repo.init', { path }),

  /* Status / staging */
  statusGet: (path: string, includeUntracked: boolean = true) =>
    rpc<IStatusResult>('status.get', { path, includeUntracked }),
  statusStage: (path: string, files: string[]) =>
    rpc<{}>('status.stage', { path, files }),
  statusUnstage: (path: string, files: string[]) =>
    rpc<{}>('status.unstage', { path, files }),
  statusUnstageAll: (path: string) => rpc<{}>('status.unstageAll', { path }),
  statusDiscard: (
    path: string,
    files: string[],
    includeUntracked: boolean = true,
    moveToTrash: boolean = false,
  ) => rpc<{}>('status.discard', { path, files, includeUntracked, moveToTrash }),

  /* Diffs */
  diffWorkingDirectory: (
    path: string,
    file: { path: string; status: FileChange['status'] },
    hideWhitespace: boolean = false,
  ) => rpc<Diff>('diff.workingDirectory', { path, file, hideWhitespace }),
  diffCommit: (path: string, file: { path: string }, commitish: string) =>
    rpc<Diff>('diff.commit', { path, file, commitish }),
  diffStash: (path: string, stashSha: string, file: { path: string }) =>
    rpc<Diff>('diff.stash', { path, stashSha, file }),

  /* Commits / history */
  commitCreate: (
    path: string,
    message: { summary: string; description: string },
    files?: string[],
    amend: boolean = false,
    allowEmpty: boolean = false,
  ) =>
    rpc<{ sha: string }>('commit.create', {
      path,
      message,
      ...(files ? { files } : {}),
      amend,
      allowEmpty,
    }),
  logList: (path: string, revisionRange?: string, limit: number = 100, skip: number = 0) =>
    rpc<Commit[]>('log.list', { path, ...(revisionRange ? { revisionRange } : {}), limit, skip }),
  logOneLine: (path: string, revisionRange?: string, limit: number = 100) =>
    rpc<CommitOneLine[]>('log.oneLine', { path, ...(revisionRange ? { revisionRange } : {}), limit }),
  logCommit: (path: string, ref: string) => rpc<Commit | null>('log.commit', { path, ref }),
  logChangedFiles: (path: string, sha: string) =>
    rpc<ChangedFilesResult>('log.changedFiles', { path, sha }),
  commitUndo: (path: string, sha: string) => rpc<{}>('commit.undo', { path, sha }),
  commitResetTo: (path: string, sha: string, mode: 'soft' | 'mixed' | 'hard') =>
    rpc<{}>('commit.resetTo', { path, sha, mode }),

  /* Branches */
  branchList: (path: string) => rpc<Branch[]>('branch.list', { path }),
  branchCreate: (path: string, name: string, startPoint?: string | null) =>
    rpc<{}>('branch.create', {
      path,
      name,
      ...(startPoint ? { startPoint } : {}),
    }),
  branchRename: (path: string, name: string, newName: string) =>
    rpc<{}>('branch.rename', { path, name, newName }),
  branchDelete: (path: string, branch: { name: string; type: 'local' | 'remote' }) =>
    rpc<{}>('branch.delete', { path, branch }),
  branchCheckout: (path: string, name: string) => rpc<{}>('branch.checkout', { path, name }),
  commitCheckout: (path: string, sha: string) => rpc<{}>('commit.checkout', { path, sha }),
  branchAheadBehind: (path: string, branch: { name: string; upstream: string | null }) =>
    rpc<AheadBehind>('branch.aheadBehind', { path, branch }),

  /* Remotes */
  remoteList: (path: string) => rpc<Remote[]>('remote.list', { path }),
  remoteAdd: (path: string, name: string, url: string) =>
    rpc<{}>('remote.add', { path, name, url }),
  remoteRemove: (path: string, name: string) => rpc<{}>('remote.remove', { path, name }),
  remoteSetUrl: (path: string, name: string, url: string) =>
    rpc<{}>('remote.setUrl', { path, name, url }),

  /* Tags */
  tagList: (path: string) => rpc<TagMap>('tag.list', { path }),
  tagCreate: (path: string, name: string, targetCommitSha: string) =>
    rpc<{}>('tag.create', { path, name, targetCommitSha }),
  tagDelete: (path: string, name: string) => rpc<{}>('tag.delete', { path, name }),

  /* Stash */
  stashList: (path: string) => rpc<StashEntry[]>('stash.list', { path }),
  stashCreate: (path: string, branchName: string, includeUntracked: boolean = true) =>
    rpc<{}>('stash.create', { path, branchName, includeUntracked }),
  stashPop: (path: string, stashSha: string) => rpc<{}>('stash.pop', { path, stashSha }),
  stashDrop: (path: string, stashSha: string) => rpc<{}>('stash.drop', { path, stashSha }),

  /* Config / identity */
  configGetValue: (name: string, path?: string, onlyLocal: boolean = false) =>
    rpc<string | null>('config.getValue', { name, ...(path ? { path } : {}), onlyLocal }),
  configSetValue: (name: string, value: string, path?: string, onlyLocal: boolean = false) =>
    rpc<{}>('config.setValue', { name, value, ...(path ? { path } : {}), onlyLocal }),
  configAuthor: (path: string) => rpc<CommitIdentity | null>('config.author', { path }),

  /* Network (progress is pushed on the matching `/ws` event) */
  fetch: (path: string, remote?: string) =>
    rpc<{}>('fetch', { path, ...(remote ? { remote } : {}) }),
  pull: (path: string, remote: string) => rpc<{}>('pull', { path, remote }),
  push: (
    path: string,
    remote: string,
    localBranch: string,
    remoteBranch?: string | null,
    tagsToPush?: string[],
    forceWithLease: boolean = false,
  ) =>
    rpc<{}>('push', {
      path,
      remote,
      localBranch,
      ...(remoteBranch ? { remoteBranch } : {}),
      ...(tagsToPush && tagsToPush.length > 0 ? { tagsToPush } : {}),
      forceWithLease,
    }),
  clone: (url: string, path: string, options?: { branch?: string; defaultBranch?: string }) =>
    rpc<Repository>('clone', { url, path, ...(options ? { options } : {}) }),
}
