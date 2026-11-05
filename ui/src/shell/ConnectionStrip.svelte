<script lang='ts'>
  import { localhostDashboardUrl } from '../lib/insights.ts'
  import { retryScope } from '../lib/poller.svelte.ts'
  import { app } from '../lib/store.svelte.ts'

  // Only while the connection is lost or blocked (403/421). The context bar carries the last update time.
  const connection = $derived(app.connection)
</script>

{#if connection.state === 'lost' || connection.state === 'blocked'}
  <div class='connection-strip' role='status'>
    {#if connection.state === 'lost'}
      <p>Can't reach ghc-proxy — {app.live ? 'retrying every 2 s' : 'Live is paused'}</p>
      <button type='button' class='btn ghost sm' onclick={() => retryScope('overview')}>Retry now</button>
    {:else}
      <p>
        Access denied — {connection.blockedMessage}
        {#if connection.blockedStatus === 421}<a href={localhostDashboardUrl(location.href)}>Open on localhost</a>{/if}
      </p>
    {/if}
  </div>
{/if}
