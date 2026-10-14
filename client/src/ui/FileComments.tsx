/**
 * File comments for the primary changes / diff / preview surface.
 *
 * Comments are anchored to a file (with an optional line + side) and
 * stored per-repo by the daemon, so they survive reloads. "Send to
 * agent" hands the comment body to the `comment` task — another slow
 * LLM CLI call, so every control exposes its busy state (the busy id is
 * the comment's own id, or `load` / `create` for the panel-level ones).
 */

import { useEffect, useRef, useState } from 'react'
import type { Comment } from '../api/types'
import { useStore } from '../state/store'
import { Button, ConfirmButton, EmptyState, Spinner } from './common'

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** `open` / `sent` — the daemon's comment status vocabulary. */
export function commentStatusLabel(status: Comment['status']): string {
  return status === 'sent' ? 'sent' : 'open'
}

function CommentRow({ comment }: { comment: Comment }) {
  const { state, actions } = useStore()
  const sending = state.commentsBusy === comment.id

  return (
    <div className="comment-row">
      <div className="comment-meta">
        <span className={`comment-badge ${comment.status}`}>
          {commentStatusLabel(comment.status)}
        </span>
        <span className="chip mono" title={comment.line === null ? 'File-level comment' : `Anchored to line ${comment.line} (${comment.side ?? 'new'} side)`}>
          {comment.line === null ? 'file' : `${comment.side === 'old' ? 'L' : 'R'}${comment.line}`}
        </span>
        <span className="hint">{formatTimestamp(comment.createdAt)}</span>
        <span className="grow" />
        {comment.status === 'open' ? (
          <Button
            small
            disabled={sending}
            busy={sending}
            title="Ask the configured agent to answer this comment (slow — runs an LLM CLI on the server)"
            onClick={() => void actions.sendComment(comment.id)}
          >
            Send to agent
          </Button>
        ) : comment.agent ? (
          <span className="hint" title={`Answered by ${comment.agent}`}>
            {comment.agent}
          </span>
        ) : null}
        <ConfirmButton
          small
          variant="ghost"
          disabled={sending}
          question="Delete this comment?"
          confirmLabel="Delete"
          title="Delete this comment"
          onConfirm={() => void actions.deleteComment(comment.id)}
        >
          🗑
        </ConfirmButton>
      </div>

      <div className="comment-body">{comment.body}</div>

      {comment.reply ? (
        <div className="comment-reply">
          <span className="hint">agent reply</span>
          <pre>{comment.reply}</pre>
        </div>
      ) : null}
    </div>
  )
}

export function FileComments({ file }: { file: string | null }) {
  const { state, actions } = useStore()
  const [body, setBody] = useState('')
  const [anchored, setAnchored] = useState(false)
  const [line, setLine] = useState('')
  const [side, setSide] = useState<'old' | 'new'>('new')

  // A comment list is per file — remember which file we already read so
  // re-renders (and StrictMode's double effect) don't re-fetch it.
  const loadedFor = useRef<string | null>(null)

  const comments = file ? (state.comments[file] ?? []) : []
  const busyId = state.commentsBusy
  const loading = busyId === 'load'
  const creating = busyId === 'create'

  useEffect(() => {
    if (!file) {
      loadedFor.current = null
      return
    }
    if (loadedFor.current === file) return
    loadedFor.current = file
    void actions.loadComments(file)
  }, [file, actions])

  // Drop the draft comment when the previewed file changes.
  useEffect(() => {
    setBody('')
    setLine('')
    setAnchored(false)
  }, [file])

  const submit = async () => {
    if (!file || creating) return
    const trimmed = body.trim()
    if (trimmed.length === 0) return
    const parsedLine = anchored ? Number.parseInt(line, 10) : Number.NaN
    const created = await actions.createComment({
      file,
      line: Number.isNaN(parsedLine) ? null : parsedLine,
      side: anchored ? side : null,
      body: trimmed,
    })
    if (created !== null) {
      setBody('')
      setLine('')
      setAnchored(false)
    }
  }

  if (!file) return null

  return (
    <section className="comments-panel" aria-label={`Comments on ${file}`}>
      <header className="comments-panel-head">
        <strong>Comments</strong>
        <span className="count">({comments.length})</span>
        <span className="grow" />
        <span className="hint">{file}</span>
        {loading ? <Spinner /> : null}
      </header>

      <div className="comment-list">
        {comments.length === 0 ? (
          loading ? (
            <div className="hint" style={{ padding: '8px 12px' }} aria-busy="true">
              Loading comments…
            </div>
          ) : (
            <EmptyState icon="💬" title="No comments yet">
              Ask an agent about this file by adding a comment below.
            </EmptyState>
          )
        ) : (
          comments.map((comment) => <CommentRow key={comment.id} comment={comment} />)
        )}
      </div>

      <form
        className="comment-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          rows={2}
          placeholder={`Add a comment about ${file}…`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Comment body"
        />
        <div className="comment-form-row">
          <label className="row" title="Anchor the comment to a line of the file">
            <input
              type="checkbox"
              checked={anchored}
              onChange={(e) => setAnchored(e.target.checked)}
              aria-label="Anchor the comment to a line"
            />
            <span className="hint">line</span>
          </label>
          {anchored ? (
            <>
              <input
                type="text"
                inputMode="numeric"
                placeholder="123"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                aria-label="Comment line number"
                className="comment-line-input"
              />
              <select
                value={side}
                onChange={(e) => setSide(e.target.value as 'old' | 'new')}
                aria-label="Comment side"
                className="comment-side-select"
              >
                <option value="new">new</option>
                <option value="old">old</option>
              </select>
            </>
          ) : null}
          <span className="grow" />
          <Button
            small
            variant="primary"
            type="submit"
            disabled={creating || body.trim().length === 0}
            busy={creating}
            aria-busy={creating}
          >
            Add comment
          </Button>
        </div>
      </form>
    </section>
  )
}
