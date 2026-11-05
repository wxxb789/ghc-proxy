import { mount } from 'svelte'
import App from './App.svelte'
import { refreshSelectedView, startPolling } from './lib/poller.svelte.ts'
import { startRouter } from './lib/router.svelte.ts'
import { readShortcutsEnabled } from './lib/shortcuts.ts'
import { app } from './lib/store.svelte.ts'
import { followSystemTheme, readThemePref } from './lib/theme.ts'
import './styles/app.css'

// Composition root: the router reads the hash before the first render and
// before the initial load (the M365 auto-probe depends on the starting view).
startRouter(view => void refreshSelectedView(view))
app.prefs.theme = readThemePref()
app.prefs.shortcuts = readShortcutsEnabled()
followSystemTheme()
mount(App, { target: document.getElementById('app')! })
void startPolling()
