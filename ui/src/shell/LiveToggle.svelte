<script lang='ts'>
  import Lamp from '../components/Lamp.svelte'
  import { app, toggleLive } from '../lib/store.svelte.ts'

  // In-memory only (never persisted); `compact` is the ≤900 top-bar variant: lamp only,
  // named `Live updates` with the state in aria-pressed (no visible text to mismatch).
  const { compact = false }: { compact?: boolean } = $props()
  const trouble = $derived(['reconnecting', 'lost', 'blocked'].includes(app.connection.state))
  const lamp = $derived(!app.live || app.connection.state === 'connecting' ? 'hollow' : trouble ? 'bad' : 'ok')
</script>

<button type='button' class={['btn', 'live', compact ? 'ghost' : 'secondary']} aria-pressed={app.live} aria-label={compact ? 'Live updates' : undefined} onclick={toggleLive}>
  <Lamp tone={lamp} />
  {#if !compact}
    <span>{app.live ? 'Live' : 'Paused'}</span>
    {#if app.live}<span class='live-meta'>{trouble ? 'retrying' : '2 s'}</span>{/if}
  {/if}
</button>
