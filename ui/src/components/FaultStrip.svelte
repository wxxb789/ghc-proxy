<script lang='ts'>
  import type { DataScope } from '../lib/store.svelte.ts'
  import { formatClock } from '../lib/format.ts'
  import { retryScope } from '../lib/poller.svelte.ts'
  import { app, faults, SCOPE_LABEL } from '../lib/store.svelte.ts'

  // Last-known data stays rendered under the strip; the announcer speaks the transition.
  const { scope }: { scope: DataScope } = $props()
  const fault = $derived(faults[scope])
  const loadedAt = $derived(app.loadedAt[scope])
</script>

{#if fault}
  <div class='fault-strip'>
    <p>Couldn't load {SCOPE_LABEL[scope]}: {fault.message}{#if loadedAt}<span class='muted'>{` · showing data from ${formatClock(loadedAt)}`}</span>{/if}</p>
    <button type='button' class='btn ghost sm' onclick={() => retryScope(scope)}>Retry</button>
  </div>
{/if}
