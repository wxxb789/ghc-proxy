<script lang='ts'>
  import type { DashboardQuota, DashboardQuotaDetail } from '@contract'
  import EmptyState from '../../components/EmptyState.svelte'
  import Meter from '../../components/Meter.svelte'
  import Nil from '../../components/Nil.svelte'
  import Panel from '../../components/Panel.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import Tag from '../../components/Tag.svelte'
  import { formatClock, formatDate, formatNumber, formatPercent } from '../../lib/format.ts'
  import { quotaTone } from '../../lib/tone.ts'

  // Quota panel (spec §5.1). `quota` is undefined until the first overview success.
  const { quota, loaded, stale }: { quota: DashboardQuota | undefined, loaded: boolean, stale: boolean } = $props()

  const NOT_APPLICABLE = 'Not applicable: Microsoft 365 does not expose GitHub quota'
  // A missing quota counts as unavailable (legacy).
  const q = $derived<DashboardQuota>(quota ?? { status: 'unavailable' })
  const pools = $derived<Array<[string, DashboardQuotaDetail | undefined]>>([['Premium', q.premiumInteractions], ['Chat', q.chat], ['Completions', q.completions]])
  const noData = $derived((q.status === 'stale' || q.status === 'unavailable') && pools.every(([, detail]) => !detail))
  const details = $derived([
    q.resetDate && `resets ${formatDate(q.resetDate)}`,
    q.plan && `${q.plan} plan`,
    q.fetchedAt && `fetched ${formatClock(q.fetchedAt)}`,
  ].filter(Boolean).join(' · '))
  // Only a fetch problem gets a tag: a green "ok" would read as a verdict on the meters below.
  const fetchProblem = $derived(q.status === 'stale' || q.status === 'unavailable')
</script>

{#snippet cell(label: string, value: string | false | undefined, numeric = true)}
  <td data-label={label} class={{ num: numeric, muted: value === 'No' }}>{#if value}{value}{:else}<Nil />{/if}</td>
{/snippet}

<Panel title='Quota' id='quota' flush>
  {#snippet meta()}
    {#if stale}<Tag value='stale' tone='warn' />{/if}
    {#if loaded && q.status !== 'not_applicable'}<span>{#if fetchProblem}<Tag value={q.status} domain='health' />{/if} {details}</span>{/if}
  {/snippet}
  {#if !loaded}
    <div class='pad' aria-busy='true'><Skeleton lines={3} /></div>
  {:else if q.status === 'not_applicable'}
    <EmptyState title={NOT_APPLICABLE} />
  {:else if noData}
    <EmptyState title='No quota data yet.' />
  {:else}
    <div class='table-scroll'>
      <table class='table reflow-blocks'>
        <thead><tr><th scope='col'>Pool</th><th scope='col' class='num'>Remaining</th><th scope='col' class='num'>Entitlement</th><th scope='col' class='num'>Percent</th><th scope='col'>Overage</th></tr></thead>
        <tbody>
          {#each pools as [label, detail] (label)}
            {@const limited = detail && !detail.unlimited}
            <tr>
              <td data-label='Pool'>{label}</td>
              {@render cell('Remaining', detail && (detail.unlimited ? 'Unlimited' : formatNumber(detail.remaining)))}
              {@render cell('Entitlement', limited && formatNumber(detail.entitlement))}
              <td data-label='Percent' class='num'>
                {#if limited && Number.isFinite(detail.percentRemaining)}<Meter value={detail.percentRemaining} label='{label} remaining' tone={quotaTone(detail)} /> {formatPercent(detail.percentRemaining)}{:else}<Nil />{/if}
              </td>
              {@render cell('Overage', limited && (detail.overagePermitted ? 'Allowed' : 'No'), false)}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if q.status === 'stale'}<p class='panel-foot'>Showing last known values.</p>{/if}
  {/if}
</Panel>

<style>
  .pad { padding: var(--s-4); }
  .table td { white-space: nowrap; }
</style>
