import * as React from 'react'

interface IMarkdownTextProps {
  /** The markdown to render. */
  readonly text: string
  /** Called with the href when a link is clicked. */
  readonly onLinkClick: (url: string) => void
}

/**
 * A deliberately small markdown renderer for agent replies.
 *
 * The rest of the app renders untrusted markdown into a sandboxed iframe,
 * which is a poor fit for chat bubbles, so this turns the handful of
 * constructs agents actually emit into React elements instead. Anything it
 * doesn't understand is shown as plain text.
 */
export class MarkdownText extends React.Component<IMarkdownTextProps> {
  public render() {
    return (
      <div className="agent-chat-markdown">
        {renderBlocks(this.props.text, this.props.onLinkClick)}
      </div>
    )
  }
}

interface IMarkdownLinkProps {
  readonly url: string
  readonly onLinkClick: (url: string) => void
}

/** A link whose click is handed to the app instead of navigating the frame. */
class MarkdownLink extends React.Component<IMarkdownLinkProps> {
  private onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    this.props.onLinkClick(this.props.url)
  }

  public render() {
    return (
      <a href={this.props.url} onClick={this.onClick}>
        {this.props.children}
      </a>
    )
  }
}

const fence = /^```(\S*)\s*$/
const closingFence = /^```\s*$/
const heading = /^(#{1,6})\s+(.*)$/
const bullet = /^\s*[-*+]\s+(.*)$/
const ordered = /^\s*\d+[.)]\s+(.*)$/

function renderBlocks(
  text: string,
  onLinkClick: (url: string) => void
): ReadonlyArray<React.ReactNode> {
  const lines = text.split('\n')
  const blocks = new Array<React.ReactNode>()
  const paragraph = new Array<string>()
  let index = 0
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return
    }

    const id = `p${key++}`
    blocks.push(
      <p key={id}>{renderInline(paragraph.join(' '), id, onLinkClick)}</p>
    )
    paragraph.length = 0
  }

  while (index < lines.length) {
    const line = lines[index]

    if (fence.test(line)) {
      flushParagraph()
      const code = new Array<string>()
      index++
      while (index < lines.length && !closingFence.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      index++
      blocks.push(
        <pre key={`c${key++}`}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    const headingMatch = heading.exec(line)
    if (headingMatch !== null) {
      flushParagraph()
      const id = `h${key++}`
      // Chat messages sit inside a dialog, so shift headings down and keep
      // them near body size.
      const level = Math.min(headingMatch[1].length + 2, 6)
      blocks.push(
        React.createElement(
          `h${level}`,
          { key: id },
          renderInline(headingMatch[2], id, onLinkClick)
        )
      )
      index++
      continue
    }

    if (bullet.test(line) || ordered.test(line)) {
      flushParagraph()
      const isOrdered = ordered.test(line)
      const pattern = isOrdered ? ordered : bullet
      const id = `${isOrdered ? 'o' : 'u'}${key++}`
      const items: Array<React.ReactNode> = []

      while (index < lines.length) {
        const itemMatch = pattern.exec(lines[index])
        if (itemMatch === null) {
          break
        }
        const itemKey = `${id}-${items.length}`
        items.push(
          <li key={itemKey}>
            {renderInline(itemMatch[1], itemKey, onLinkClick)}
          </li>
        )
        index++
      }

      blocks.push(
        isOrdered ? <ol key={id}>{items}</ol> : <ul key={id}>{items}</ul>
      )
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph()
      index++
      continue
    }

    paragraph.push(line.trim())
    index++
  }

  flushParagraph()

  return blocks
}

function renderInline(
  text: string,
  keyPrefix: string,
  onLinkClick: (url: string) => void
): ReadonlyArray<React.ReactNode> {
  const nodes = new Array<React.ReactNode>()
  // Local to each call: the recursion below would otherwise clobber the
  // shared regex's lastIndex and skip the rest of the outer text.
  const inline =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))/g
  let lastIndex = 0
  let index = 0
  let match: RegExpExecArray | null

  while ((match = inline.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    const key = `${keyPrefix}-i${index++}`

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="agent-chat-inline-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key}>
          {renderInline(token.slice(2, -2), key, onLinkClick)}
        </strong>
      )
    } else if (token.startsWith('*')) {
      nodes.push(
        <em key={key}>{renderInline(token.slice(1, -1), key, onLinkClick)}</em>
      )
    } else {
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(token)
      if (link === null) {
        nodes.push(token)
      } else {
        const url = link[2]
        nodes.push(
          <MarkdownLink key={key} url={url} onLinkClick={onLinkClick}>
            {link[1]}
          </MarkdownLink>
        )
      }
    }

    lastIndex = inline.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}
