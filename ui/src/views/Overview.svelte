<script lang='ts'>
  import FaultStrip from '../components/FaultStrip.svelte'
  import IssueRow from '../components/IssueRow.svelte'
  import Kv from '../components/Kv.svelte'
  import Lamp from '../components/Lamp.svelte'
  import Panel from '../components/Panel.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Tag from '../components/Tag.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { formatCooldowns, formatDate, formatDuration, formatNumber } from '../lib/format.ts'
  import { health } from '../lib/health.svelte.ts'
  import { app, faults } from '../lib/store.svelte.ts'
  import AuthPanel from './overview/AuthPanel.svelte'
  import Cluster from './overview/Cluster.svelte'
  import QuotaPanel from './overview/QuotaPanel.svelte'

  // Overview (spec §5.1): summary, Issues (warn/bad only), cluster, Quota + Authentication, Runtime.
  const overview = $derived(app.data.overview)
  const runtime = $derived.by(() => {
    if (!overview)
      return null
    const { activity } = overview
    const queue = activity.upstreamQueue
    return [
      ['Started', formatDate(overview.startedAt)],
      ['Requests started', formatNumber(activity.started)],
      ['Recent finished', formatNumber(activity.recentRequests)],
      ['Upstream slots', `${formatNumber(queue.active)} / ${formatNumber(queue.concurrency)}`],
      ['Pending queue', `${formatNumber(queue.pending)} / ${formatNumber(queue.maxPending)}`],
      ['Cooldowns', formatCooldowns(queue)],
      ['Version', overview.version],
    ]
  })
  // Last-known overview data under an overview fault: every overview-fed region shows a stale tag.
  const stale = $derived(!!faults.overview && !!app.loadedAt.overview)
</script>

<div class='intro'>
  <ViewHeader title='Overview'>
    {#snippet meta()}
      {#if overview}
        <Tag value={overview.status} domain='health' />
        <span>· {overview.auth.upstream === 'm365' ? 'Microsoft 365' : 'GitHub'} upstream · up {formatDuration(overview.uptimeMs)}</span>
      {/if}
    {/snippet}
  </ViewHeader>
  <p class='summary'><Lamp tone={health.summary.tone} />{health.summary.text}</p>
  {#if overview && overview.auth.accounts.totalAccounts > 1}
    <p class='meta'>Overview, quota and models reflect "{overview.auth.accounts.currentAccount}". Requests and Behavior cover every account.</p>
  {/if}
</div>
<FaultStrip scope='overview' />
<div class='grid-12'>
  {#if health.worst}
    <Panel title='Issues' id='issues' flush>
      {#snippet meta()}{health.issues.length}{/snippet}
      <ul class='issue-list'>
        {#each health.issues as issue (issue.id)}<IssueRow {issue} />{/each}
      </ul>
    </Panel>
  {/if}
  <Cluster {overview} {stale} />
  <div class='col-quota'><QuotaPanel quota={overview?.quota} loaded={!!overview} {stale} /></div>
  <div class='col-auth'><AuthPanel auth={overview?.auth} {stale} /></div>
  <Panel title='Runtime' id='runtime'>
    {#snippet meta()}{#if stale}<Tag value='stale' tone='warn' />{/if}{/snippet}
    {#if runtime}
      <dl class='kv cols-3 runtime'>
        {#each runtime as [label, value] (label)}<Kv {label} {value} mono={label === 'Version'} />{/each}
      </dl>
    {:else}
      <div aria-busy='true'><Skeleton lines={3} /></div>
    {/if}
  </Panel>
</div>

<style>
  .intro { display: grid; gap: var(--s-2); }
  /* The lamp stays on the first line when the summary wraps (centred on its 22 px line). */
  .summary { display: flex; align-items: flex-start; gap: var(--s-2); font-size: 15px; line-height: 22px; font-weight: 500; }
  .summary :global(.lamp) { margin-top: 7px; }
  .col-quota, .col-auth { display: grid; min-width: 0; }
  /* 901–1279 Quota and Authentication stay full width: half a row is narrower than the quota table. */
  @media (min-width: 1280px) {
    .col-quota { grid-column: span 7; }
    .col-auth { grid-column: span 5; }
  }
  @media (min-width: 901px) and (max-width: 1279px) {
    .runtime { columns: 2; column-gap: var(--s-6); display: block; }
    .runtime :global(.kv-row) { break-inside: avoid; }
  }
</style>
