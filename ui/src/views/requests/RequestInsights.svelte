<script lang='ts' module>
  // Insights start collapsed at ≤900 px: decided once per page, then the user's toggle wins.
  let sized = false
</script>

<script lang='ts'>
  import type { ObservedRequest } from '@contract'
  import type { Share } from '../../lib/insights.ts'
  import { formatDuration, formatPercent } from '../../lib/format.ts'
  import { ringInsights } from '../../lib/insights.ts'
  import { app } from '../../lib/store.svelte.ts'

  interface Props {
    /** Shown rows from `recent` / `active` (spec §6.4). */
    recent: ObservedRequest[]
    active: ObservedRequest[]
    now: number
    filtered: boolean
  }

  const { recent, active, now, filtered }: Props = $props()
  const MIX_KEYS = ['ok', 'client', 'server', 'aborted'] as const

  if (!sized) {
    sized = true
    if (window.matchMedia?.('(max-width: 900px)').matches)
      app.ui.insightsOpen = false
  }

  const insights = $derived(ringInsights(recent, active, now))
  const mix = $derived(insights.mix)
  const terminal = $derived(mix.ok + mix.client + mix.server + mix.aborted)
  const segments = $derived.by(() => {
    let x = 0
    return MIX_KEYS.map((key) => {
      const width = (mix[key] / terminal) * 100
      x += width
      return { key, x: x - width, width }
    })
  })
  // A mustache keeps the spaces that Svelte trims at the edges of an `{#if}` block.
  const SEPARATOR = ' · '
  const summary = $derived(`· last ${insights.finished} finished${insights.spanMs === null ? '' : ` · spanning ${formatDuration(insights.spanMs)}`}${filtered ? ' · filtered' : ''}`)
</script>

<!-- One inline-block per share: lines break between shares, and an over-long id still wraps inside its own. -->
{#snippet shares(list: Share[], counts = false)}{#each list as share, index (index)}{#if index}{SEPARATOR}{/if}<span class='share'>{share.label} {share.pct} %{counts ? ` (${share.count})` : ''}</span>{/each}{/snippet}

<details class='panel req-insights' bind:open={app.ui.insightsOpen}>
  <summary>
    <span class='strong'>Insights</span> {summary}
  </summary>
  {#if terminal}
    <dl class='grid'>
      <div>
        <dt class='placard'>Latency</dt>
        <dd>
          {#if insights.latency}
            p50 {formatDuration(insights.latency.p50)} · p95 {formatDuration(insights.latency.p95)} · max {formatDuration(insights.latency.max)}
          {:else}
            — <span class='muted'>needs 5 completed requests</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt class='placard'>Status</dt>
        <dd>
          <svg class='mix' viewBox='0 0 100 8' preserveAspectRatio='none' aria-hidden='true'>
            {#each segments as segment (segment.key)}<rect class='mix-{segment.key}' x={segment.x} width={segment.width} height='8' />{/each}
          </svg>
          2xx {mix.ok} · 4xx {mix.client} · 5xx {mix.server} · aborted {mix.aborted} · error rate {formatPercent(mix.errorRate ?? undefined)}
        </dd>
      </div>
      {#if insights.finished}
        <div><dt class='placard'>Top models</dt><dd>{@render shares(insights.topModels, true)}</dd></div>
        <div><dt class='placard'>Strategies</dt><dd>{@render shares(insights.strategies)}</dd></div>
        {#if insights.accounts}<div><dt class='placard'>Accounts</dt><dd>{@render shares(insights.accounts)}</dd></div>{/if}
      {/if}
    </dl>
  {:else}
    <p class='muted note'>{filtered ? 'No finished requests.' : 'No finished requests yet.'}</p>
  {/if}
</details>

<style>
  summary { padding: var(--s-3) var(--s-4); color: var(--text-2); cursor: pointer; }
  .req-insights[open] summary { border-bottom: 1px solid var(--line); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: var(--s-3) var(--s-6); padding: var(--s-3) var(--s-4); }
  dd { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .share { display: inline-block; max-width: 100%; }
  .note { padding: var(--s-3) var(--s-4); }
  .mix { display: block; width: 100%; height: 8px; margin: 4px 0; }
  .mix rect { stroke: var(--bg-1); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .mix-ok { fill: var(--chart-ink-3); }
  .mix-client { fill: var(--warn-fg); }
  .mix-server { fill: var(--bad-fg); }
  .mix-aborted { fill: var(--warn-line); }
</style>
