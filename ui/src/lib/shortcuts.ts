import type { View } from './router.svelte.ts'

const SHORTCUTS_KEY = 'ghc-proxy-dashboard-shortcuts'

export type ShortcutAction
  = | { kind: 'view', view: View }
    | { kind: 'filter' }
    | { kind: 'live' }
    | { kind: 'help' }

const VIEW_KEYS: Record<string, View> = { 1: 'overview', 2: 'requests', 3: 'accounts', 4: 'models', 5: 'behavior' }

/** Single-key shortcuts are on unless the user stored `'off'` (WCAG 2.1.4 off switch). */
export function readShortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== 'off'
  }
  catch {
    return true
  }
}

export function writeShortcutsEnabled(enabled: boolean): void {
  try {
    if (enabled)
      localStorage.removeItem(SHORTCUTS_KEY)
    else
      localStorage.setItem(SHORTCUTS_KEY, 'off')
  }
  catch {
    // Storage can be unavailable; the switch still applies for this page.
  }
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

/**
 * Maps a keydown to a global single-key shortcut, or `null` when a guard
 * applies (spec §8.4). No shortcut ever refreshes, probes or mutates.
 */
export function matchShortcut(event: KeyboardEvent, enabled: boolean): ShortcutAction | null {
  if (!enabled || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented)
    return null
  if (isEditable(event.target) || document.querySelector('dialog[open]'))
    return null
  const view = Object.hasOwn(VIEW_KEYS, event.key) ? VIEW_KEYS[event.key] : undefined
  if (view)
    return { kind: 'view', view }
  if (event.key === '/')
    return { kind: 'filter' }
  if (event.key === 'l')
    return { kind: 'live' }
  if (event.key === '?')
    return { kind: 'help' }
  return null
}
