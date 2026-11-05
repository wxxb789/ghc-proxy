<script lang='ts'>
  import IssueRow from '../components/IssueRow.svelte'
  import Kv from '../components/Kv.svelte'
  import Lamp from '../components/Lamp.svelte'
  import Panel from '../components/Panel.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Tag from '../components/Tag.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { formatClockOrDate, formatCooldowns, formatNumber } from '../lib/format.ts'
  import { health } from '../lib/health.svelte.ts'
  import { app, faults } from '../lib/store.svelte.ts'
  import AuthPanel from './overview/AuthPanel.svelte'
  import Cluster from './overview/Cluster.svelte'
  import QuotaPanel from './overview/QuotaPanel.svelte'

  // Overview (spec §5.1): summary, Issues (warn/bad only), cluster, Quota + Authentication, Runtime.
  // The overview fault has no strip here: its Issues row carries the message, since/count and Retry.
  const overview = $derived(app.data.overview)
  // Slots and pending live in the Queue tile.
  const runtime = $derived.by(() => {
    if (!overview)
      return null
    const { activity } = overview
    return [
      ['Started', formatClockOrDate(overview.startedAt)],
      ['Requests started', formatNumber(activity.started)],
      ['Recent finished', formatNumber(activity.recentRequests)],
      ['Cooldown', formatCooldowns(activity.upstreamQueue)],
      ['Version', overview.version],
    ]
  })
  // The view's verdict is last-known while the connection is down, so it shows only while connected.
  const connected = $derived(app.connection.state === 'connected')
  // Last-known overview data under an overview fault: every overview-fed region shows a stale tag.
  const stale = $derived(!!faults.overview && !!app.loadedAt.overview)
</script>

<div class='intro'>
  <ViewHeader title='Overview'>
    {#snippet meta()}
      {#if overview}
        {#if connected}<Tag value={overview.status} domain='health' />{/if}
        <span>{connected ? '· ' : ''}{overview.auth.upstream === 'm365' ? 'Microsoft 365' : 'GitHub'} upstream</span>
      {/if}
    {/snippet}
  </ViewHeader>
  <!-- A warn/bad issue (connection included) heads the Issues panel instead. -->
  {#if !health.worst}<p class='summary'><Lamp tone={health.summary.tone} />{health.summary.text}</p>{/if}
</div>
<div class='grid-12'>
  {#if health.worst}
    <Panel title='Issues' id='issues' flush>
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
      <dl class='kv runtime'>
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
  /* ≥1280 one row of label-over-value cells; 901–1279 two kv columns; narrower stacks. */
  @media (min-width: 1280px) {
    .runtime { grid-template-columns: repeat(5, minmax(0, 1fr)); column-gap: var(--s-6); }
    .runtime :global(.kv-row) { grid-template-columns: minmax(0, 1fr); gap: 0; border-bottom: 0; }
  }
  @media (min-width: 901px) and (max-width: 1279px) {
    .runtime { columns: 2; column-gap: var(--s-6); display: block; }
    .runtime :global(.kv-row) { break-inside: avoid; }
  }
</style>
