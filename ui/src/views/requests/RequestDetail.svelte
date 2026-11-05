<script lang='ts'>
  import type { ObservedRequest } from '@contract'
  import CodeBlock from '../../components/CodeBlock.svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import Icon from '../../components/Icon.svelte'
  import Kv from '../../components/Kv.svelte'
  import Nil from '../../components/Nil.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import Tag from '../../components/Tag.svelte'
  import { formatClockOrDate, formatDuration, relTime } from '../../lib/format.ts'
  import { app } from '../../lib/store.svelte.ts'
  import { httpTone } from '../../lib/tone.ts'
  import { elapsed, isTicking } from './helpers.ts'

  interface Props {
    request: ObservedRequest | null
    loading: boolean
    /** Median latency of the unfiltered completed rows (n ≥ 5), for `N.N× median`. */
    p50: number | undefined
    now: number
    fetchedAt: number
    /** Esc inside the detail: back to the selected row. */
    onescape: () => void
  }

  const { request, loading, p50, now, fetchedAt, onescape }: Props = $props()
  const effectInfo = $derived(new Map(app.data.behavior?.effects.map(effect => [effect.id, effect]) ?? []))
  const duration = $derived(request ? elapsed(request, now, fetchedAt) : 0)
  const tone = $derived(httpTone(request?.status))
  const ratio = $derived(request && p50 && !isTicking(request) ? (request.durationMs / p50).toFixed(1) : '')
  const ago = $derived(request ? relTime(request.startedAt, now) : '')
  // A mustache keeps the trailing space that Svelte trims at the end of an element.
  const DURATION = 'Duration '
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc returns focus to the selected row, spec §8.4) -->
<aside class='panel req-detail' aria-labelledby='request-detail-h' onkeydown={event => event.key === 'Escape' && onescape()}>
  <header class='panel-head'><h2 id='request-detail-h' tabindex='-1'>Request detail</h2></header>
  <div class='panel-body stack'>
    {#if loading}
      <Skeleton lines={6} />
    {:else if !request}
      <EmptyState title='No request selected' />
    {:else}
      {#key request.requestId}
        <p class='row'>
          <Tag value={request.state} domain='request' />
          <span class={['mono', tone === 'warn' && 'fg-warn', tone === 'bad' && 'fg-bad']}>{#if tone}{request.status}{:else}<Nil />{/if}</span>
          <span class='num'><span class='sr-only'>{DURATION}</span>{formatDuration(duration)}</span>
          {#if ratio}<span class='muted'>{ratio}× median</span>{/if}
        </p>
        {#if request.errorSummary}
          <div class='callout tone-bad'><Icon name='x' /><p class='callout-text'>{request.errorSummary}</p></div>
        {/if}
        <CodeBlock text={request.requestId} label='request ID' />
        <section>
          <h3 class='placard'>Route</h3>
          <dl class='kv'>
            <Kv label='Endpoint' mono value='{request.method} {request.endpoint}' />
            <Kv label='Account' value={request.accountName} />
            <Kv label='Strategy' mono value={request.selectedStrategy} />
          </dl>
        </section>
        <section>
          <h3 class='placard'>Model</h3>
          <p class='mono chain'>
            {#if request.modelTransforms.length}
              {request.requestedModel || request.modelTransforms[0]!.from}
              {#each request.modelTransforms as transform, index (index)}
                → <Tag value={transform.tag} kind='mono' /> → {transform.to}
              {/each}
            {:else if request.effectiveModel || request.requestedModel}
              {request.effectiveModel || request.requestedModel}
            {:else}
              <Nil />
            {/if}
          </p>
        </section>
        {#if request.effects.length}
          <section>
            <h3 class='placard'>Effects</h3>
            <ul class='effects'>
              {#each request.effects as effect (effect.id)}
                {@const info = effectInfo.get(effect.id)}
                <li>
                  <span>{info ? `${info.category} · ${info.label}` : effect.id}</span>
                  <span class='num'>×{effect.count}</span>
                  {#if info}<span class='mono muted id'>{effect.id}</span>{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <section>
          <h3 class='placard'>Timing</h3>
          <dl class='kv'>
            <Kv label='Started' value='{formatClockOrDate(request.startedAt, now)}{ago && ` (${ago})`}' />
          </dl>
        </section>
        <details bind:open={app.ui.rawJsonOpen}>
          <summary>Raw JSON</summary>
          <CodeBlock id='request-detail' text={JSON.stringify(request, null, 2)} label='request JSON' tall />
        </details>
      {/key}
    {/if}
  </div>
</aside>

<style>
  .req-detail { position: sticky; top: 56px; max-height: calc(100dvh - 72px); overflow: auto; container-type: inline-size; }
  .chain { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1); overflow-wrap: anywhere; }
  .effects { display: grid; }
  .effects li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--s-3); padding: 4px 0; border-bottom: 1px solid var(--line); }
  .effects li:last-child { border-bottom: 0; }
  .id { grid-column: 1 / -1; }
  summary { cursor: pointer; margin-bottom: var(--s-2); color: var(--text-2); font-weight: 600; }

  /* A narrow label column keeps values on the label's line; only a very narrow aside stacks label over value. */
  .kv :global(.kv-row) { grid-template-columns: 6rem minmax(0, 1fr); gap: var(--s-3); }
  @container (max-width: 299px) {
    .kv :global(.kv-row) { grid-template-columns: minmax(0, 1fr); gap: 0; }
  }

  @media (max-width: 900px) {
    .req-detail { position: static; max-height: none; }
  }
</style>
