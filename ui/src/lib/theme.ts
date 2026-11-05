import type { ThemePref } from './store.svelte.ts'

const THEME_KEY = 'ghc-proxy-dashboard-theme'
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

/** The preference `theme-init.js` resolved before first paint. */
export function readThemePref(): ThemePref {
  const pref = document.documentElement.dataset.themePref
  return pref === 'light' || pref === 'dark' ? pref : 'system'
}

function applyTheme(pref: ThemePref): void {
  const root = document.documentElement
  root.dataset.themePref = pref
  root.dataset.theme = pref === 'system' ? (darkQuery().matches ? 'dark' : 'light') : pref
}

/** System removes the stored key; Light and Dark store `'light'` / `'dark'` (legacy key and values). */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system')
      localStorage.removeItem(THEME_KEY)
    else
      localStorage.setItem(THEME_KEY, pref)
  }
  catch {
    // Storage can be unavailable; the choice still applies for this page.
  }
  applyTheme(pref)
}

/** Follows OS theme changes while the preference is System. Returns an unsubscribe function. */
export function followSystemTheme(): () => void {
  const query = darkQuery()
  const onChange = () => {
    if (readThemePref() === 'system')
      applyTheme('system')
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
