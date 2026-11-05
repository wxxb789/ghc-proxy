<script lang='ts'>
  import type { IconName } from '../components/Icon.svelte'
  import type { View } from '../lib/router.svelte.ts'
  import Icon from '../components/Icon.svelte'
  import Lamp from '../components/Lamp.svelte'
  import Tag from '../components/Tag.svelte'
  import { formatTime } from '../lib/format.ts'
  import { health } from '../lib/health.svelte.ts'
  import { router, VIEW_LABEL, VIEWS } from '../lib/router.svelte.ts'
  import { app } from '../lib/store.svelte.ts'
  import LiveToggle from './LiveToggle.svelte'
  import RefreshMetadata from './RefreshMetadata.svelte'
  import StatusList from './StatusList.svelte'
  import ThemeSwitch from './ThemeSwitch.svelte'

  // Desktop rail; at ≤900 px the same markup becomes the drawer opened from the top bar.
  const GROUPS: Array<[string, View[]]> = [['Monitor', ['overview', 'requests']], ['Configure', ['accounts', 'models', 'behavior']]]

  let rail: HTMLElement
  const active = $derived(app.data.overview?.activity.activeRequests ?? 0)

  function closeDrawer(restoreFocus: boolean) {
    if (!app.ui.drawerOpen)
      return
    app.ui.drawerOpen = false
    if (restoreFocus)
      document.getElementById('menu-button')?.focus()
  }

  function onpointerdown(event: PointerEvent) {
    const target = event.target as Node
    if (!rail.contains(target) && !document.getElementById('menu-button')?.contains(target))
      closeDrawer(true)
  }

  $effect(() => {
    if (app.ui.drawerOpen)
      rail.querySelector<HTMLElement>('nav a')?.focus()
  })
</script>

<svelte:document {onpointerdown} />

<div bind:this={rail} id='rail' class={['rail', app.ui.drawerOpen && 'open']} role='presentation' onkeydown={event => event.key === 'Escape' && closeDrawer(true)}>
  <p class='brand'><Icon name='mark' /><span class='brand-name'>ghc-proxy</span><span class='brand-version'>{app.data.overview ? `v${app.data.overview.version}` : ''}</span></p>
  <nav aria-label='Dashboard views'>
    {#each GROUPS as [group, views] (group)}
      <p class='placard'>{group}</p>
      {#each views as view (view)}
        <a href='#/{view}' class='nav-item' aria-current={router.view === view ? 'page' : undefined} onclick={() => closeDrawer(false)}>
          <Icon name={view as IconName} />
          <span class='nav-label'>{VIEW_LABEL[view]}</span>
          {#if view === 'requests' && active > 0}<Tag value='{active} active' tone='info' />{/if}
          {#if view === 'accounts' && health.accountsLamp}
            <span class='nav-lamp' title='As of {formatTime(app.loadedAt.accounts)}'><Lamp tone={health.accountsLamp} /><span class='sr-only'>{health.accountsLamp === 'bad' ? 'needs attention' : 'has warnings'}</span></span>
          {/if}
          {#if app.prefs.shortcuts}<kbd>{VIEWS.indexOf(view) + 1}</kbd>{/if}
        </a>
      {/each}
    {/each}
  </nav>
  <StatusList />
  <div class='rail-foot'>
    <div class='rail-live'><LiveToggle /></div>
    <ThemeSwitch />
    <RefreshMetadata />
    <button type='button' class='btn ghost full' onclick={() => app.ui.shortcutsOpen = true}>
      <Icon name='keyboard' />Keyboard shortcuts{#if app.prefs.shortcuts}<kbd>?</kbd>{/if}
    </button>
  </div>
</div>
