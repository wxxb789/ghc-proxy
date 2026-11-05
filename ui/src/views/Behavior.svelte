<script lang='ts'>
  import FaultStrip from '../components/FaultStrip.svelte'
  import Kv from '../components/Kv.svelte'
  import Meter from '../components/Meter.svelte'
  import Panel from '../components/Panel.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Tag from '../components/Tag.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { formatNumber, plural } from '../lib/format.ts'
  import { app, effectsBaseline, faults } from '../lib/store.svelte.ts'
  import { parameterRows, routingRows } from './behavior/rows.ts'

  // Spec §5.5. Structured kv values; `Raw JSON` restores the legacy compactJson strings.
  const data = $derived(app.data.behavior)
  const raw = $derived(app.ui.behaviorRaw)
  const stale = $derived(!!faults.behavior && !!app.loadedAt.behavior)

  const effects = $derived((data?.effects ?? []).toSorted((left, right) =>
    right.count - left.count || left.category.localeCompare(right.category) || left.label.localeCompare(right.label)))
  const active = $derived(effects.filter(effect => effect.count > 0).length)
  const maxCount = $derived(effects[0]?.count ?? 0)
  const shown = $derived(app.ui.hideZeroEffects ? effects.filter(effect => effect.count > 0) : effects)

  /** `+N` since the first behavior load after page open or restart (§6.6); empty when 0. */
  function sinceOpen(id: string, count: number): string {
    const delta = count - (effectsBaseline.map?.get(id) ?? count)
    return delta > 0 ? `+${formatNumber(delta)}` : ''
  }
</script>

{#snippet staleTag()}
  {#if stale}<Tag value='stale' tone='warn' />{/if}
{/snippet}

{#snippet kvPanel(title: string, key: 'routing' | 'params', rows: typeof routingRows)}
  <Panel {title} meta={staleTag}>
    {#snippet actions()}
      <button type='button' class='btn ghost sm' aria-pressed={raw[key]} aria-label='Raw JSON for {title}' onclick={() => raw[key] = !raw[key]}>Raw JSON</button>
    {/snippet}
    {#if data}
      <dl class='kv'>
        {#each rows(data, raw[key]) as row (row.label)}
          <Kv label={row.label} mono={row.mono && !row.muted && row.value.length > 0} title={row.title}>
            {#if !row.value.length}
              <span class='muted'>none</span>
            {:else if typeof row.value === 'string'}
              <span class={{ muted: row.muted }}>{row.value}</span>
            {:else if row.chain}
              <span class='chain'>{#each row.value as strategy, index (index)}{#if index}<span class='then' aria-hidden='true'>→</span> <span class='sr-only'>then</span>{/if} <Tag value={strategy} kind='mono' />{/each}</span>
            {:else}
              {#each row.value as line, index (index)}<span class='line'>{line}</span>{/each}
            {/if}
          </Kv>
        {/each}
      </dl>
    {:else}
      <div aria-busy='true'><span class='sr-only'>Loading Behavior…</span><Skeleton lines={6} /></div>
    {/if}
  </Panel>
{/snippet}

<ViewHeader title='Behavior'>
  {#snippet meta()}Current process configuration{/snippet}
</ViewHeader>
<FaultStrip scope='behavior' />

<div class='behavior-grid'>
  {@render kvPanel('Model routing', 'routing', routingRows)}
  {@render kvPanel('Parameters and context', 'params', parameterRows)}
</div>

<Panel title='Effects since startup' id='effects' flush>
  {#snippet meta()}
    {@render staleTag()}
    {#if data}<span>{plural(effects.length, 'effect')} · {formatNumber(active)} active</span>{/if}
  {/snippet}
  {#snippet actions()}
    <label class='check'><input type='checkbox' checked={app.ui.hideZeroEffects} onchange={event => app.ui.hideZeroEffects = event.currentTarget.checked} /> Hide zero</label>
  {/snippet}
  <div class='table-scroll' aria-busy={data ? undefined : 'true'}>
    {#if !data}<span class='sr-only'>Loading Behavior…</span>{/if}
    <table class='table effects'>
      <thead><tr><th scope='col'>Category</th><th scope='col'>Effect</th><th scope='col' class='num'>Count</th><th scope='col' class='num'>Since open</th></tr></thead>
      <tbody>
        {#if data}
          {#each shown as effect (effect.id)}
            {@const delta = sinceOpen(effect.id, effect.count)}
            <tr class={{ zero: !effect.count }}>
              <td data-label='Category'>{effect.category}</td>
              <td data-label='Effect'>{effect.label}<span class='sub mono'>{effect.id}</span></td>
              <td data-label='Count' class='num'>
                <span class='count'>
                  {#if effect.count}<Meter value={effect.count / maxCount * 100} label='{effect.label} relative to the highest count' class='meter-64' />{/if}
                  <span>{formatNumber(effect.count)}{#if delta}<span class='since-inline'> ({delta})</span>{/if}</span>
                </span>
              </td>
              <td data-label='Since open' class='num since'>{delta}</td>
            </tr>
          {/each}
        {:else}
          {#each { length: 8 }, index (index)}
            <tr><td colspan='4'><Skeleton /></td></tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</Panel>

<style>
  .behavior-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-4);
  }
  .chain {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1);
  }
  .then {
    color: var(--text-3);
  }
  .effects .count {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--s-2);
    font-variant-numeric: tabular-nums;
  }
  .effects .zero {
    color: var(--text-3);
  }
  .since-inline {
    display: none;
  }
  .since {
    color: var(--text-2);
  }
  @media (max-width: 1100px) {
    .behavior-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 560px) {
    .effects :global(.meter),
    .effects .since {
      display: none;
    }
    .since-inline {
      display: inline;
    }
  }
</style>
