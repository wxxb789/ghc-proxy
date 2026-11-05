<script lang='ts'>
  import type { OverviewResponse } from '@contract'
  import type { SampleKey } from '../../lib/samples.ts'
  import MicroBars from '../../components/MicroBars.svelte'
  import Nil from '../../components/Nil.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import Sparkline from '../../components/Sparkline.svelte'
  import Tag from '../../components/Tag.svelte'
  import { formatClock, formatDuration, formatNumber, formatPercent } from '../../lib/format.ts'
  import { buckets, failureRate, peak, premiumUsed, sinceOpen, sparkRuns, sumDelta, throughput, windowMinutes } from '../../lib/samples.ts'
  import { app, samples } from '../../lib/store.svelte.ts'

  // The six legacy tiles plus the derived strip (spec §4.7, §5.1, §6.3). Charts are
  // drawn against the newest sample's time, so they freeze while Live is off.
  const { overview, stale }: { overview: OverviewResponse | null, stale: boolean } = $props()

  const activity = $derived(overview?.activity)
  const queue = $derived(activity?.upstreamQueue)
  const list = $derived(samples.list)
  const latest = $derived(list.at(-1))
  const now = $derived(latest?.t ?? 0)
  const span = $derived(windowMinutes(list))
  const minutes = $derived(span || '<1')
  const rate = $derived(throughput(list, now))
  const used = $derived(premiumUsed(list))

  const rose = (key: SampleKey, tone: string) => sumDelta(list, key, now - 300_000) > 0 && tone
  const sinceOpenText = (key: SampleKey) => `+${formatNumber(sinceOpen(samples.first, latest, key) ?? 0)} since open`
</script>

{#snippet head(label: string, value: string, sub: string, rise?: string | false)}
  <span class='placard'>{label}</span>
  {#if overview}
    <span class={['readout', rise]}>{value}</span>
    <span class='tile-sub'>{sub}</span>
  {:else}
    <span class='readout muted'>—</span>
    <Skeleton />
  {/if}
{/snippet}

<div class='panel'>
  <div class='cluster' role='group' aria-label='Runtime summary'>
    <div class='tile'>
      {@render head('Uptime', formatDuration(overview?.uptimeMs), `since ${formatClock(overview?.startedAt)}`)}
    </div>
    <a class='tile' href='#/requests?state=active' aria-label='Active requests: {formatNumber(activity?.activeRequests)}. Show active requests'>
      {@render head('Active', formatNumber(activity?.activeRequests), list.length < 2 ? 'collecting…' : `peak ${formatNumber(peak(list, 'active') ?? 0)} · ${minutes} min`)}
      <Sparkline runs={sparkRuns(list, 'active', now)} label='Active' minutes={span} />
    </a>
    <div class='tile'>
      {@render head('Completed', formatNumber(activity?.completed), `incl. ${formatNumber(activity?.failed)} failed`)}
      <MicroBars buckets={buckets(list, 'completed', now)} />
    </div>
    <a class='tile' href='#/requests?state=failed' aria-label='Failed requests: {formatNumber(activity?.failed)}. Show failed requests'>
      {@render head('Failed', formatNumber(activity?.failed), sinceOpenText('failed'), rose('failed', 'fg-bad'))}
      <MicroBars buckets={buckets(list, 'failed', now)} tone='bad' />
    </a>
    <div class='tile'>
      {@render head('Aborted', formatNumber(activity?.aborted), sinceOpenText('aborted'), rose('aborted', 'fg-warn'))}
      <MicroBars buckets={buckets(list, 'aborted', now)} tone='warn' />
    </div>
    <div class='tile'>
      {@render head('Queue', `${formatNumber(queue?.active)} / ${formatNumber(queue?.pending)}`, `${formatNumber(queue?.concurrency)} slots · max ${formatNumber(queue?.maxPending)}`)}
      <Sparkline runs={sparkRuns(list, 'qActive', now)} second={sparkRuns(list, 'qPending', now)} label='Queue' minutes={span} />
    </div>
  </div>
  <div class='derived'>
    <p><span class='placard'>Throughput</span> {#if rate === null}<Nil /> <span class='muted'>collecting…</span>{:else}{formatNumber(Math.round(rate * 10) / 10)} /min{/if}</p>
    <p><span class='placard'>Failure rate</span> {formatPercent(failureRate(list) ?? undefined)}</p>
    {#if used}<p><span class='placard'>Premium used</span> {formatNumber(used)}</p>{/if}
    <p class='end'>{#if stale}<Tag value='stale' tone='warn' />{/if} {app.live ? `since page open · ${minutes} min` : 'Live is paused'}</p>
  </div>
</div>

<style>
  /* No overflow clipping: the sparkline's end dot overhangs the right edge. The one link tile on a
     panel corner (Active, top-right in the 2-column layout) rounds its own hover background. */
  @media (max-width: 560px) {
    a.tile:nth-child(2) { border-top-right-radius: calc(var(--r-3) - 1px); }
  }
  .derived p { font-variant-numeric: tabular-nums; }
  .derived .placard { margin-right: var(--s-1); }
</style>
