import type { Action } from 'svelte/action'

export interface RovingGridOptions {
  /** Called after keyboard navigation moves the cursor (Requests: selection follows focus). */
  onMove?: (row: HTMLElement) => void
}

const STEP: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }

/**
 * Roving tabindex over `[data-row]` descendants (spec §4.4): one tab stop,
 * ↑/↓, Home/End and PageUp/PageDown (±10). Render rows with `tabindex='-1'`;
 * group-header rows simply omit `data-row`. The stop prefers the
 * `aria-selected="true"` row when the current one disappears.
 */
export const rovingGrid: Action<HTMLElement, RovingGridOptions | undefined> = (node, initial) => {
  let options = initial ?? {}
  const rows = () => [...node.querySelectorAll<HTMLElement>('[data-row]')]

  const setStop = (stop: HTMLElement) => {
    for (const row of rows())
      row.tabIndex = row === stop ? 0 : -1
  }

  const ensureStop = () => {
    const all = rows()
    if (all.length && !all.some(row => row.tabIndex === 0))
      setStop(all.find(row => row.getAttribute('aria-selected') === 'true') ?? all[0]!)
  }

  const onKeydown = (event: KeyboardEvent) => {
    const current = (event.target as Element).closest<HTMLElement>('[data-row]')
    if (!current || event.target !== current || event.altKey || event.ctrlKey || event.metaKey)
      return
    const all = rows()
    const index = all.indexOf(current)
    let next: number
    if (event.key === 'Home')
      next = 0
    else if (event.key === 'End')
      next = all.length - 1
    else if (Object.hasOwn(STEP, event.key))
      next = Math.min(all.length - 1, Math.max(0, index + STEP[event.key]!))
    else
      return
    event.preventDefault()
    const row = all[next]!
    setStop(row)
    row.focus()
    row.scrollIntoView?.({ block: 'nearest' })
    options.onMove?.(row)
  }

  const onFocusin = (event: FocusEvent) => {
    const row = event.target instanceof HTMLElement && event.target.matches('[data-row]') ? event.target : null
    if (row)
      setStop(row)
  }

  const observer = new MutationObserver(ensureStop)
  observer.observe(node, { childList: true, subtree: true })
  node.addEventListener('keydown', onKeydown)
  node.addEventListener('focusin', onFocusin)
  ensureStop()

  return {
    update(next) {
      options = next ?? {}
    },
    destroy() {
      observer.disconnect()
      node.removeEventListener('keydown', onKeydown)
      node.removeEventListener('focusin', onFocusin)
    },
  }
}
