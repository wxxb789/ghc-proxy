<script lang='ts'>
  import Lamp from '../components/Lamp.svelte'
  import { app, toggleLive } from '../lib/store.svelte.ts'

  // In-memory only (never persisted). The visible `Live`/`Paused` word names the button and
  // aria-pressed carries the state; `compact` is the ≤900 top-bar variant, where ≤560 px
  // hides the word visually (CSS) and leaves the lamp.
  const { compact = false }: { compact?: boolean } = $props()
  const trouble = $derived(['reconnecting', 'lost', 'blocked'].includes(app.connection.state))
  const lamp = $derived(!app.live || app.connection.state === 'connecting' ? 'hollow' : trouble ? 'bad' : 'ok')
</script>

<button type='button' class={['btn', 'live', compact ? 'ghost' : 'secondary']} aria-pressed={app.live} onclick={toggleLive}>
  <Lamp tone={lamp} />
  <span class='live-label'>{app.live ? 'Live' : 'Paused'}</span>
</button>
