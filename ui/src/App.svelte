<script lang='ts'>
  import type { Component } from 'svelte'
  import type { View } from './lib/router.svelte.ts'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import { useClock } from './lib/clock.svelte.ts'
  import { navigate, router } from './lib/router.svelte.ts'
  import { matchShortcut } from './lib/shortcuts.ts'
  import { app, toggleLive } from './lib/store.svelte.ts'
  import Announcer from './shell/Announcer.svelte'
  import ConnectionStrip from './shell/ConnectionStrip.svelte'
  import ContextBar from './shell/ContextBar.svelte'
  import Rail from './shell/Rail.svelte'
  import ShortcutsDialog from './shell/ShortcutsDialog.svelte'
  import TopBar from './shell/TopBar.svelte'
  import Accounts from './views/Accounts.svelte'
  import Behavior from './views/Behavior.svelte'
  import Models from './views/Models.svelte'
  import Overview from './views/Overview.svelte'
  import Requests from './views/Requests.svelte'

  const VIEW_COMPONENTS: Record<View, Component> = { overview: Overview, requests: Requests, accounts: Accounts, models: Models, behavior: Behavior }
  const ActiveView = $derived(VIEW_COMPONENTS[router.view])

  // `lost <age>` counts up on the shared clock only while the connection is lost and Live is on.
  $effect(() => {
    if (app.connection.state === 'lost' && app.live)
      return useClock()
  })

  function onkeydown(event: KeyboardEvent) {
    const action = matchShortcut(event, app.prefs.shortcuts)
    if (!action)
      return
    event.preventDefault()
    if (action.kind === 'view')
      navigate(action.view)
    else if (action.kind === 'filter')
      document.querySelector<HTMLInputElement>('main input[type=search]')?.focus()
    else if (action.kind === 'live')
      toggleLive()
    else
      app.ui.shortcutsOpen = true
  }

  // The hash is the router's; the skip link moves focus without touching it.
  function skipToContent(event: MouseEvent) {
    event.preventDefault()
    document.getElementById('view-h1')?.focus()
  }
</script>

<svelte:window {onkeydown} />

<a class='skip-link' href='#view-h1' onclick={skipToContent}>Skip to content</a>
<header class='shell'>
  <TopBar />
  <Rail />
</header>
<div class='main-col'>
  <ContextBar />
  <ConnectionStrip />
  <main id='main'><ActiveView /></main>
</div>
<Announcer />
<ConfirmDialog />
<ShortcutsDialog />
