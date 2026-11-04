import { useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export const THEME_STORAGE_KEY = 'ghc-proxy-dashboard-theme'

export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
  const [theme, setTheme] = useState<ThemePreference>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      return stored === 'light' || stored === 'dark' ? stored : 'system'
    }
    catch {
      return 'system'
    }
  })
  function updateTheme(theme: ThemePreference) {
    setTheme(theme)
    if (theme === 'system')
      delete document.documentElement.dataset.theme
    else
      document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    }
    catch {
      // The current tab still uses the selected theme when storage is disabled.
    }
  }
  return [theme, updateTheme]
}
