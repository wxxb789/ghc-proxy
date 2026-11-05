<script lang='ts'>
  import Icon from '../components/Icon.svelte'
  import { router, VIEW_LABEL } from '../lib/router.svelte.ts'
  import { app } from '../lib/store.svelte.ts'
  import LiveToggle from './LiveToggle.svelte'

// ≤900 px only (CSS-switched): menu, brand, current view, Live.
</script>

<div class='topbar'>
  <button id='menu-button' type='button' class='btn ghost icon-btn' aria-label='Menu' aria-expanded={app.ui.drawerOpen} aria-controls='rail'
          onclick={() => app.ui.drawerOpen = !app.ui.drawerOpen}><Icon name='menu' /></button>
  <p class='brand'><Icon name='mark' /><span class='brand-name'>ghc-proxy</span></p>
  <span class='topbar-view'>{VIEW_LABEL[router.view]}</span>
  <LiveToggle compact />
</div>
