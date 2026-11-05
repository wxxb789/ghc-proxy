<script lang='ts'>
  import { formatClock } from '../lib/format.ts'
  import { app } from '../lib/store.svelte.ts'
  import { isCompactChrome } from './compact.svelte.ts'
  import IssuesButton from './IssuesButton.svelte'

  const accounts = $derived(app.data.overview?.auth.accounts)
  const updatedAt = $derived(app.loadedAt.overview)
  // The rail Connection row is the visible RTT readout; `rttMs` is never cleared, so the title shows it only while connected.
  const rtt = $derived(app.connection.state === 'connected' && app.connection.rttMs !== null ? `${app.connection.rttMs} ms` : undefined)
  // `Restarted HH:MM:SS` for 60 s after a restart; each poll re-evaluates.
  const restarted = $derived(app.restartedAt && updatedAt && updatedAt.getTime() - app.restartedAt.getTime() < 60_000 ? app.restartedAt : null)
</script>

<div class='context' role='group' aria-label='Page context'>
  <p class='context-left'>
    <span class='muted'>Viewing</span>
    {#if accounts}<span class='mono' title={location.host}>{accounts.currentAccount}</span>{/if}
    {#if accounts && accounts.currentAccount !== accounts.defaultAccount}<span class='context-note'>· not default</span>{/if}
  </p>
  <p class='context-right' title={rtt}>
    {#if app.busy.metadata}Refreshing metadata…
    {:else if restarted}Restarted {formatClock(restarted)}
    {:else if updatedAt}Updated {formatClock(updatedAt)}
    {/if}
  </p>
  <!-- ≤900 px: the Issues button moves to the top bar. -->
  {#if !isCompactChrome()}<IssuesButton />{/if}
</div>
