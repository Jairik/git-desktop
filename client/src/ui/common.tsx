/**
 * Small reusable UI primitives (hand-rolled; no component kit).
 * - Button: variants + busy state
 * - TextInput / SelectField / TextArea: labeled form controls
 * - Spinner, EmptyState
 * - ConfirmButton: two-step "Are you sure?" button (no window.confirm)
 */

import {
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

export function Spinner() {
  return <span className="spinner" role="status" aria-label="loading" />
}

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'link'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  small?: boolean
  busy?: boolean
}

export function Button({
  variant = 'default',
  small = false,
  busy = false,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn', variant === 'default' ? '' : variant, small ? 'small' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} disabled={disabled || busy} {...rest}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  )
}

/** Two-step confirm button: first click asks, second click confirms. */
export function ConfirmButton({
  confirmLabel = 'Confirm',
  question = 'Are you sure?',
  onConfirm,
  disabled,
  ...buttonProps
}: ButtonProps & { confirmLabel?: string; question?: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <Button {...buttonProps} disabled={disabled} onClick={() => setAsking(true)}>
        {buttonProps.children}
      </Button>
    )
  }
  return (
    <span className="row">
      <span className="hint">{question}</span>
      <Button
        small
        variant="danger"
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          setAsking(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      <Button small variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  )
}

export function TextInput({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  if (!label) return <input type="text" {...props} />
  return (
    <label className="field">
      <span>{label}</span>
      <input type="text" {...props} />
    </label>
  )
}

export function TextArea({
  label,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  if (!label) return <textarea {...props} />
  return (
    <label className="field">
      <span>{label}</span>
      <textarea {...props} />
    </label>
  )
}

export function SelectField({
  label,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  if (!label) return <select {...props} />
  return (
    <label className="field">
      <span>{label}</span>
      <select {...props} />
    </label>
  )
}

export function EmptyState({
  icon = '🗂',
  title,
  children,
}: {
  icon?: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="big" aria-hidden>
        {icon}
      </div>
      <strong>{title}</strong>
      {children ? <div className="hint">{children}</div> : null}
    </div>
  )
}

/** Human label + badge class for an AppFileStatus. */
export function fileStatusLabel(kind: string): string {
  switch (kind) {
    case 'new':
      return 'New'
    case 'modified':
      return 'Modified'
    case 'deleted':
      return 'Deleted'
    case 'renamed':
      return 'Renamed'
    case 'copied':
      return 'Copied'
    case 'conflicted':
      return 'Conflicted'
    case 'untracked':
      return 'Untracked'
    default:
      return kind
  }
}

/** Short label for progress event names (`fetch.progress` → `Fetch`). */
export function progressEventLabel(event: string): string {
  const verb = event.split('.')[0]
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}
