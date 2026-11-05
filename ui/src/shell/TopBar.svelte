<script lang='ts'>
  import Icon from '../components/Icon.svelte'
  import { router, VIEW_LABEL } from '../lib/router.svelte.ts'
  import { app } from '../lib/store.svelte.ts'
  import { isCompactChrome } from './compact.svelte.ts'
  import IssuesButton from './IssuesButton.svelte'
  import LiveToggle from './LiveToggle.svelte'

// ≤900 px only (CSS-switched): menu, brand, current view, Issues, Live.
</script>

<div class='topbar'>
  <button id='menu-button' type='button' class='btn ghost icon-btn' aria-label='Menu' aria-expanded={app.ui.drawerOpen} aria-controls='rail'
          onclick={() => app.ui.drawerOpen = !app.ui.drawerOpen}><Icon name='menu' /></button>
  <p class='brand'><Icon name='mark' /><span class='brand-name'>ghc-proxy</span></p>
  <span class='topbar-view'>{VIEW_LABEL[router.view]}</span>
  {#if isCompactChrome()}<IssuesButton />{/if}
  <LiveToggle compact />
</div>
