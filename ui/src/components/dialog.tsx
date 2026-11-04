import type { ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'

export interface NativeDialogProps {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
}

export function NativeDialog({ open, title, children, onClose }: NativeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const element = dialogRef.current
    if (!element)
      return
    if (open && !element.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
    }
    else if (!open && element.open) {
      element.close()
    }
    if (!open)
      returnFocusRef.current?.focus()
  }, [open])
  useEffect(() => () => returnFocusRef.current?.focus(), [])
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <h2 id={headingId}>{title}</h2>
        <button type="button" aria-label="Close dialog" onClick={onClose}>×</button>
      </div>
      {children}
    </dialog>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  targetName: string
  pending?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({ open, targetName, pending = false, error, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <NativeDialog open={open} title={`Remove ${targetName}?`} onClose={onCancel}>
      <p>
        Remove route target
        {' '}
        <strong>{targetName}</strong>
        {' '}
        from this proxy? Clients using its hostname will no longer be able to route through it.
      </p>
      {error && <p className="tone-failed">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="button" className="button-danger" onClick={onConfirm} disabled={pending}>{pending ? 'Removing…' : `Remove ${targetName}`}</button>
      </div>
    </NativeDialog>
  )
}
