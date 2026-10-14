/**
 * TypeScript types mirroring the JSON shapes in
 * docs/architecture/server-client.md (v1).
 *
 * These are the wire types: field names are camelCase and union
 * values are discriminated by `kind`. Keep this file in sync with
 * the contract — it is the single source of truth for the client.
 */

/* ------------------------------------------------------------------ */
/* Data types                                                          */
/* ------------------------------------------------------------------ */

export interface Repository {
  id: string
  path: string
  alias: string | null
  missing: boolean
}

export type RepositoryType =
  | { kind: 'regular'; topLevelWorkingDirectory: string; gitDir: string }
  | { kind: 'bare'; gitDir: string }
  | { kind: 'missing' }
  | { kind: 'unsafe'; path: string }

export type AppFileStatus =
  | { kind: 'new' }
  | { kind: 'modified' }
  | { kind: 'deleted' }
  | { kind: 'renamed'; oldPath: string }
  | { kind: 'copied'; oldPath: string }
  | { kind: 'conflicted'; conflictedEntry: { kind: 'conflicted' } }
  | { kind: 'untracked' }

export interface SubmoduleStatus {
  commitChanged?: boolean
  modifiedChanges?: boolean
  untrackedChanges?: boolean
}

export interface FileChange {
  id: string
  path: string
  status: AppFileStatus
  submoduleStatus?: SubmoduleStatus | null
}

export interface WorkingDirectoryStatus {
  files: FileChange[]
  includeAll: boolean | null
}

export interface AheadBehind {
  ahead: number
  behind: number
}

export interface IStatusResult {
  currentBranch: string | null
  currentUpstreamBranch: string | null
  currentTip: string | null
  branchAheadBehind: AheadBehind | null
  exists: boolean
  mergeHeadFound: boolean
  squashMsgFound: boolean
  isCherryPickingHeadFound: boolean
  workingDirectory: WorkingDirectoryStatus
  doConflictedFilesExist: boolean
}

export type BranchType = 'local' | 'remote'

export interface Branch {
  name: string
  ref: string
  upstream: string | null
  tip: { sha: string }
  type: BranchType
}

export interface Remote {
  name: string
  url: string
}

export interface CommitIdentity {
  name: string
  email: string
  /** ISO-8601 */
  date: string
  /** minutes */
  tzOffset: number
}

export interface Commit {
  sha: string
  shortSha: string
  summary: string
  body: string
  author: CommitIdentity
  committer: CommitIdentity
  parentSHAs: string[]
  tags: string[]
}

export interface CommitOneLine {
  sha: string
  summary: string
}

export interface StashEntry {
  name: string
  branchName: string
  stashSha: string
}

export type DiffLineType = 'context' | 'add' | 'delete' | 'hunk'

export interface DiffLine {
  type: DiffLineType
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export interface Hunk {
  header: string
  oldStartLine: number
  oldLineCount: number
  newStartLine: number
  newLineCount: number
  lines: DiffLine[]
}

export type Diff =
  | TextDiff
  | LargeTextDiff
  | ImageDiff
  | BinaryDiff
  | SubmoduleDiff
  | UnrenderableDiff

export interface TextDiff {
  kind: 'text'
  text: string
  hunks: Hunk[]
  lineEndingsChange?: string | null
}

export interface LargeTextDiff {
  kind: 'largeText'
  text: string
}

export interface ImageData {
  /** base64 */
  contents: string
  mediaType: string
  bytes: number
}

export interface ImageDiff {
  kind: 'image'
  previous: ImageData | null
  current: ImageData | null
}

export interface BinaryDiff {
  kind: 'binary'
}

export interface SubmoduleDiff {
  kind: 'submodule'
  fullPath: string
  url: string | null
  status: string
  oldSHA: string
  newSHA: string
}

export interface UnrenderableDiff {
  kind: 'unrenderable'
  reason: string | null
}

export interface ChangedFilesResult {
  files: FileChange[]
  linesAdded: number
  linesDeleted: number
}

export type AuthorIdentity = CommitIdentity | null

/* ------------------------------------------------------------------ */
/* GitHub (via the `gh` CLI on the server)                             */
/* ------------------------------------------------------------------ */

/** `github.status` — can the server use the GitHub CLI, and as whom? */
export interface GitHubStatus {
  available: boolean
  authenticated: boolean
  user: string | null
}

/** `github.remote` — `owner/name` parsed from the repo's `origin`. */
export interface GitHubRemote {
  owner: string
  name: string
  hostname: string
}

/** The `state` query param of `pr.list` (and a PR's own state). */
export type PullRequestState = 'open' | 'closed' | 'merged'

export interface PullRequest {
  number: number
  title: string
  state: PullRequestState
  isDraft: boolean
  url: string
  headRefName: string
  baseRefName: string
  author: { login: string } | null
  /** ISO-8601 */
  createdAt: string
  /** ISO-8601 */
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  mergeable: string | null
}

/** `pr.view` — a pull request plus its body/comments/review state. */
export interface PullRequestDetail extends PullRequest {
  body: string
  comments: number
  reviewDecision: string | null
  headSha: string | null
}

export type CheckStatus = 'queued' | 'in_progress' | 'completed'
export type CheckKind = 'check_run' | 'status'
/** Roll-up of every check for a ref. */
export type CiRollUp = 'success' | 'pending' | 'failure'

export interface Check {
  name: string
  status: CheckStatus
  conclusion: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  kind: CheckKind
}

export interface CiStatus {
  headSha: string | null
  rollUp: CiRollUp
  checks: Check[]
}

/* ------------------------------------------------------------------ */
/* Local agents, reviews & comments                                    */
/* ------------------------------------------------------------------ */

/** `agent.list` — one scanned agent CLI. */
export interface DetectedAgent {
  name: string
  command: string
  path: string | null
  available: boolean
  version: string | null
}

/** `AgentsConfig.agents` — a configured agent CLI. */
export interface AgentSpec {
  name: string
  command: string
  detect: string[]
  argv: string[]
  enabled: boolean
  env?: { [k: string]: string }
}

/** One task (`commit_message` / `summarize_file` / `review` / `comment`). */
export interface TaskConfig {
  agent: string
  skill: string | null
  prompt: string
}

/** The task keys the config editor knows about. */
export type AgentTask = 'commit_message' | 'summarize_file' | 'review' | 'comment'

export const AGENT_TASKS: AgentTask[] = ['commit_message', 'summarize_file', 'review', 'comment']

export interface AgentsConfig {
  defaultAgent: string
  agents: AgentSpec[]
  /** Keyed by {@link AgentTask}. */
  tasks: { [task: string]: TaskConfig }
  /** The file `agent.config.set` writes to. */
  configPath: string
}

/** `agent.review` target — discriminated by `kind`. */
export type ReviewTarget =
  | { kind: 'file'; file: string; ref?: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'pr'; number: number }

/** `agent.review` result — `output` is free-form agent text. */
export interface AgentReview {
  agent: string
  target: ReviewTarget
  summary: string | null
  output: string
}

/** A file comment, stored per-repo by the daemon. */
export interface Comment {
  id: string
  file: string
  line: number | null
  side: 'old' | 'new' | null
  body: string
  status: 'open' | 'sent'
  reply: string | null
  agent: string | null
  /** ISO-8601 */
  createdAt: string
}

/** `agent.commit_message` result. */
export interface CommitMessageResult {
  message: string
  agent: string
}

/** `agent.summarize_file` result. */
export interface SummarizeResult {
  summary: string
  agent: string
}

/* ------------------------------------------------------------------ */
/* Transport-level shapes                                              */
/* ------------------------------------------------------------------ */

export interface RpcEnvelopeOk {
  id: number
  ok: true
  result: unknown
}

export interface RpcEnvelopeErr {
  id: number
  ok: false
  error: { code: string; message: string; data?: unknown }
}

export type RpcEnvelope = RpcEnvelopeOk | RpcEnvelopeErr

export interface ProgressFrame {
  event: string
  data: unknown
}

/** Payload of `<verb>.progress` WebSocket events. */
export interface ProgressPayload {
  phase: string
  /** 0..100 */
  value: number
  detail?: string
}

export interface HealthResult {
  ok: boolean
  version: string
}

export interface ServerInfo {
  name: string
  version: string
  port: number
}

/** `tag.list` returns a map of tag name → sha. */
export type TagMap = Record<string, string>
