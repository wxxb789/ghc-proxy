// Resolves the theme before first paint and always sets data-theme and
// data-theme-pref. External file: the CSP forbids inline script. If this file
// fails to run, the CSS default (dark) applies.
(() => {
  let pref = null
  try {
    const stored = localStorage.getItem('ghc-proxy-dashboard-theme')
    if (stored === 'light' || stored === 'dark')
      pref = stored
  }
  catch {
    // Storage can be unavailable; follow the system preference.
  }
  const root = document.documentElement
  root.dataset.theme = pref ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  root.dataset.themePref = pref ?? 'system'
})()
