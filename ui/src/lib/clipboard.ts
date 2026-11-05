import type { StatusLine } from './account-actions.svelte.ts'

/** Copies text, falling back to a hidden textarea where the async Clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  }
  catch {
    // Fall through to the legacy path (insecure context or denied permission).
  }
  // select() focuses the textarea; focus goes back to the control that started the copy.
  const previous = document.activeElement as HTMLElement | null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  // CSSOM assignment is allowed under style-src 'self'; a style attribute is not.
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy'))
      throw new Error('Copy failed')
  }
  finally {
    textarea.remove()
    previous?.focus({ preventScroll: true })
  }
}

/**
 * Copies `text` and writes the outcome into `line` (a `$state` status line).
 * The line is emptied first (Svelte flushes it before the copy settles), so a
 * repeated outcome still changes the live region. No await precedes the copy,
 * which keeps the click's user activation for the clipboard.
 */
export async function copyInto(line: StatusLine, text: string, done = 'Copied'): Promise<boolean> {
  line.text = ''
  try {
    await copyText(text)
    Object.assign(line, { text: done, tone: 'ok' })
    return true
  }
  catch {
    Object.assign(line, { text: 'Copy failed', tone: 'error' })
    return false
  }
}
