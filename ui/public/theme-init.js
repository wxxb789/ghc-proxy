(() => {
  try {
    const theme = localStorage.getItem('ghc-proxy-dashboard-theme')
    if (theme === 'light' || theme === 'dark')
      document.documentElement.dataset.theme = theme
  }
  catch {
    // Storage can be unavailable; CSS still follows the system preference.
  }
})()
