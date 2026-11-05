<script lang='ts'>
  import Tag from '../components/Tag.svelte'
  import { formatClock } from '../lib/format.ts'
  import { app } from '../lib/store.svelte.ts'
  import IssuesButton from './IssuesButton.svelte'

  const accounts = $derived(app.data.overview?.auth.accounts)
  const updatedAt = $derived(app.loadedAt.overview)
  const rtt = $derived(app.connection.rttMs === null ? '' : `${app.connection.rttMs} ms`)
  // `Restarted HH:MM:SS` for 60 s after a restart; each poll re-evaluates.
  const restarted = $derived(app.restartedAt && updatedAt && updatedAt.getTime() - app.restartedAt.getTime() < 60_000 ? app.restartedAt : null)
</script>

<div class='context' role='group' aria-label='Page context'>
  <p class='context-left'>
    <span class='muted'>Viewing</span>
    {#if accounts}<span class='mono'>{accounts.currentAccount}</span>{/if}
    <span class='context-host'>· <span class='mono muted'>{location.host}</span></span>
    {#if accounts && accounts.currentAccount !== accounts.defaultAccount}<Tag kind='outline' value='not default' />{/if}
  </p>
  <p class='context-right' title={rtt}>
    {#if app.busy.metadata}Refreshing metadata…
    {:else if restarted}Restarted {formatClock(restarted)}
    {:else if updatedAt}Updated {formatClock(updatedAt)}{#if rtt}<span class='muted context-rtt'> · {rtt}</span>{/if}
    {/if}
  </p>
  <IssuesButton />
</div>
