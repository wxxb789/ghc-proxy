import { MediaQuery } from 'svelte/reactivity'

// Matches the ≤900 px chrome breakpoint in app.css (top bar plus drawer).
let query: MediaQuery | undefined

/**
 * True while the ≤900 px chrome shows. Used only where markup must move
 * between containers (the Issues button); everything else is CSS-switched.
 * `false` where `matchMedia` is missing (jsdom).
 */
export function isCompactChrome(): boolean {
  if (typeof window.matchMedia !== 'function')
    return false
  query ??= new MediaQuery('max-width: 900px')
  return query.current
}
