/**
 * Diff renderer for every `Diff` variant in the contract:
 * text (hunks + lines), largeText, image, binary, submodule,
 * unrenderable.
 */

import type { ReactNode } from 'react'
import type { Diff, ImageData } from '../api/types'
import { EmptyState, Spinner } from './common'

function dataUrl(image: ImageData): string {
  return `data:${image.mediaType || 'application/octet-stream'};base64,${image.contents}`
}

function TextDiffBody({ diff }: { diff: Extract<Diff, { kind: 'text' }> }) {
  if (diff.hunks.length === 0) {
    return (
      <pre className="diff-note" style={{ margin: 0 }}>
        {diff.text || '(no changes)'}
      </pre>
    )
  }
  return (
    <div>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          <div className="hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div className={`diff-line ${line.type}`} key={lineIndex}>
              <span className="ln">{line.oldLineNumber ?? ''}</span>
              <span className="ln">{line.newLineNumber ?? ''}</span>
              <span className="code">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function DiffBody({ diff }: { diff: Diff }) {
  switch (diff.kind) {
    case 'text':
      return <TextDiffBody diff={diff} />
    case 'largeText':
      return (
        <div className="diff-note">
          <p>
            This file is large — showing the raw diff text instead of a line-by-line view.
          </p>
          <pre>{diff.text}</pre>
        </div>
      )
    case 'image':
      return (
        <div className="diff-images">
          <figure>
            <figcaption>Previous</figcaption>
            {diff.previous ? (
              <img src={dataUrl(diff.previous)} alt="Previous version" />
            ) : (
              <div className="diff-note">(no previous image)</div>
            )}
          </figure>
          <figure>
            <figcaption>Current</figcaption>
            {diff.current ? (
              <img src={dataUrl(diff.current)} alt="Current version" />
            ) : (
              <div className="diff-note">(no current image)</div>
            )}
          </figure>
        </div>
      )
    case 'binary':
      return <div className="diff-note">Binary file — contents not shown.</div>
    case 'submodule':
      return (
        <div className="diff-note">
          <p>Submodule: {diff.fullPath}</p>
          <pre>
            {`status: ${diff.status}\nold: ${diff.oldSHA}\nnew: ${diff.newSHA}${diff.url ? `\nurl: ${diff.url}` : ''}`}
          </pre>
        </div>
      )
    case 'unrenderable':
      return (
        <div className="diff-note">
          This diff can’t be displayed{diff.reason ? `: ${diff.reason}` : '.'}
        </div>
      )
    default:
      return <div className="diff-note">Unknown diff type.</div>
  }
}

export function DiffPane({
  title,
  actions,
  diff,
  loading,
  error,
}: {
  /** File path shown in the header. */
  title?: string
  /** Extra header controls (e.g. Discard). */
  actions?: ReactNode
  diff: Diff | null
  loading: boolean
  error?: string | null
}) {
  let body: ReactNode
  if (loading) {
    body = (
      <div className="diff-placeholder">
        <Spinner /> Loading diff…
      </div>
    )
  } else if (error) {
    body = <div className="diff-error">{error}</div>
  } else if (diff) {
    body = <DiffBody diff={diff} />
  } else {
    body = (
      <EmptyState icon="🔍" title="Nothing selected">
        Pick a file to see its diff.
      </EmptyState>
    )
  }

  return (
    <section className="diff-pane">
      <header className="diff-header">
        {title ? <span className="file-name">{title}</span> : null}
        <span className="spacer" />
        {actions}
      </header>
      <div className="diff-body">{body}</div>
    </section>
  )
}
