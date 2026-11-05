<script lang='ts'>
  import { formatClock } from '../lib/format.ts'
  import { localhostDashboardUrl } from '../lib/insights.ts'
  import { app } from '../lib/store.svelte.ts'

  // Only while the connection is lost or blocked (403/421).
  const connection = $derived(app.connection)
</script>

{#if connection.state === 'lost' || connection.state === 'blocked'}
  <div class='connection-strip' role='status'>
    {#if connection.state === 'lost'}
      Can't reach ghc-proxy — {app.live ? 'retrying every 2 s' : 'Live is paused'} · last update {formatClock(app.loadedAt.overview)}
    {:else}
      {connection.blockedMessage}
      {#if connection.blockedStatus === 421}<a href={localhostDashboardUrl(location.href)}>Open on localhost</a>{/if}
    {/if}
  </div>
{/if}
