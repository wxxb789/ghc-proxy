<script lang='ts'>
  import FaultStrip from '../components/FaultStrip.svelte'
  import Meter from '../components/Meter.svelte'
  import Panel from '../components/Panel.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Tag from '../components/Tag.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { formatNumber } from '../lib/format.ts'
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
      <button type='button' class='btn ghost sm raw-toggle' aria-pressed={raw[key]} aria-label='Raw JSON for {title}' onclick={() => raw[key] = !raw[key]}>Raw JSON</button>
    {/snippet}
    {#if data}
      <!-- Spec §5.5: one <dl> per block; a group subhead replaces the label prefix its rows repeated. -->
      {#each Map.groupBy(rows(data, raw[key]), row => row.group) as [group, block] (group)}
        {#if group}<h3 class='placard kv-subhead'>{group}</h3>{/if}
        <dl class='kv'>
          {#each block as row (row.label)}
            <div class='kv-row'>
              <dt>{#if row.srPrefix}<span class='sr-only'>{row.srPrefix}</span><span class='short'>{row.label}</span>{:else}{row.label}{/if}{#if row.srSuffix}<span class='sr-only'>{row.srSuffix}</span>{/if}</dt>
              <dd class={{ mono: row.mono && !row.muted && row.value.length > 0 }}>
                {#if !row.value.length}
                  <span class='muted'>none</span>
                {:else if typeof row.value === 'string'}
                  <span class={{ muted: row.muted }}>{row.value}</span>
                {:else if row.chain}
                  <span class='chain'>{#each row.value as strategy, index (index)}{#if index}<span class='then' aria-hidden='true'>→</span> <span class='sr-only'>then</span>{/if} <Tag value={strategy} kind='mono' />{/each}</span>
                {:else}
                  {#each row.value as line, index (index)}<span class={['line', row.muted && 'muted']}>{line}</span>{/each}
                  {#if row.list}<span class={['line', row.muted && 'muted']}><span class='muted'>{row.list.key}</span> {#if row.list.items.length}<span class='mono'>{row.list.items.join(', ')}</span>{:else}<span class='muted'>none</span>{/if}</span>{/if}
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      {/each}
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
    {#if data}<span>{formatNumber(active)} of {formatNumber(effects.length)} active</span>{/if}
  {/snippet}
  {#snippet actions()}
    <label class='check'><input type='checkbox' checked={app.ui.hideZeroEffects} onchange={event => app.ui.hideZeroEffects = event.currentTarget.checked} /> Hide zero</label>
  {/snippet}
  <div class='table-scroll' aria-busy={data ? undefined : 'true'}>
    {#if !data}<span class='sr-only'>Loading Behavior…</span>{/if}
    <table class='table effects'>
      <thead><tr><th scope='col' class='c-category'>Category</th><th scope='col'>Effect</th><th scope='col' class='num c-count'>Count</th><th scope='col' class='num c-since'>Since open</th></tr></thead>
      <tbody>
        {#if data}
          {#each shown as effect (effect.id)}
            {@const delta = sinceOpen(effect.id, effect.count)}
            <tr class={{ zero: !effect.count }}>
              <td class='category'>{effect.category}</td>
              <td>{effect.label}<span class='sub mono'><span class='category-inline'>{`${effect.category} · `}</span>{effect.id}</span></td>
              <td class='num'>
                <span class='count'>
                  {#if effect.count}<Meter value={effect.count / maxCount * 100} label='{effect.label} relative to the highest count' class='meter-64' />{/if}
                  <span>{formatNumber(effect.count)}{#if delta}<span class='since-inline'> ({delta})</span>{/if}</span>
                </span>
              </td>
              <td class='num since'>{delta}</td>
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
  .btn.raw-toggle[aria-pressed='true'] {
    background: var(--accent-tint);
    border-color: var(--line-control);
    color: var(--text-1);
  }
  .btn.raw-toggle[aria-pressed='true']:hover {
    border-color: var(--accent);
  }
  .kv-subhead {
    margin-top: var(--s-2);
    padding-top: var(--s-2);
    border-top: 1px solid var(--line);
  }
  /* Grouped rows drop their prefix in lowercase; capitalize what is shown, not the dt text. */
  .short {
    display: inline-block;
  }
  .short::first-letter {
    text-transform: uppercase;
  }
  /* Fixed side columns so a capped Effect column keeps Count near its label. */
  .table.effects {
    max-width: 1000px;
  }
  .effects .c-category {
    width: 180px;
  }
  .effects .c-count {
    width: 200px;
  }
  .effects .c-since {
    width: 96px;
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
  .category-inline,
  .since-inline {
    display: none;
  }
  .category-inline {
    font-family: var(--font-sans);
  }
  .since {
    color: var(--text-2);
  }
  @media (max-width: 1100px) {
    .behavior-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  /* Two-line cards: label and count, then muted `Category · id` (no per-cell labels). */
  @media (max-width: 560px) {
    .table.effects tbody tr {
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: var(--s-3);
    }
    .table.effects td.num {
      text-align: right;
    }
    .effects :global(.meter),
    .effects .category,
    .effects .since {
      display: none;
    }
    .category-inline,
    .since-inline {
      display: inline;
    }
  }
  @media (forced-colors: active) {
    .btn.raw-toggle[aria-pressed='true'] {
      forced-color-adjust: none;
      background: Highlight;
      border-color: Highlight;
      color: HighlightText;
    }
  }
</style>
