<script lang='ts'>
  import type { ObservedRequest } from '@contract'
  import { untrack } from 'svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import Nil from '../../components/Nil.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import Tag from '../../components/Tag.svelte'
  import { rovingGrid } from '../../lib/actions/rovingGrid.ts'
  import { formatClockOrDate, formatDuration } from '../../lib/format.ts'
  import { app } from '../../lib/store.svelte.ts'
  import { httpTone } from '../../lib/tone.ts'
  import { fitViewport } from './fitViewport.ts'
  import { elapsed, isTicking } from './helpers.ts'

  interface Props {
    /** Visible rows; `null` before the first load. */
    rows: ObservedRequest[] | null
    /** Unfiltered row count (empty ring vs. no filter matches). */
    total: number
    selectedId: string | undefined
    showAccount: boolean
    now: number
    fetchedAt: number
    /** Keyboard move: selection follows focus. */
    onselect: (id: string) => void
    /** Click (`focus` false) or Enter (`focus` true). */
    onpick: (id: string, focus: boolean) => void
    onclear: () => void
  }

  const { rows, total, selectedId, showAccount, now, fetchedAt, onselect, onpick, onclear }: Props = $props()
  // A mustache keeps the leading space that Svelte trims at the start of an `{#if}` block.
  const PAUSED = ' (paused)'
  const columns = $derived(showAccount ? 8 : 7)
  const rowId = (target: EventTarget | null) => (target as Element).closest<HTMLElement>('[data-row]')?.dataset.id

  let scroller: HTMLElement
  // `↑ N new requests`: visible rows whose id was absent from the previous unfiltered snapshot, counted
  // while scrolled down. Reordered rows and rows revealed by a filter change were already seen.
  let fresh = $state(0)
  let seen: Set<string> | undefined
  $effect(() => {
    const data = app.data.requests
    if (!data)
      return
    const added = seen && scroller.scrollTop > 0 ? rows?.filter(row => !seen!.has(row.requestId)).length : 0
    if (added)
      fresh = untrack(() => fresh) + added
    seen = new Set([...data.active, ...data.recent].map(row => row.requestId))
  })

  // Entry (including a deep-link `?id=`): scroll the selected row into view without focusing it.
  let revealed = false
  $effect(() => {
    if (!revealed && rows?.length) {
      revealed = true
      scroller.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' })
    }
  })

  function toTop() {
    scroller.scrollTop = 0
    fresh = 0
  }

  function onkeydown(event: KeyboardEvent) {
    const id = event.key === 'Enter' && rowId(event.target)
    if (id) {
      event.preventDefault()
      onpick(id, true)
    }
  }
</script>

{#snippet orNil(value: string | number | undefined)}{#if value}{value}{:else}<Nil />{/if}{/snippet}

<div class='panel panel-flush req-list'>
  {#if fresh}<button type='button' class='btn secondary sm req-new' onclick={toTop}>↑ {fresh} new {fresh === 1 ? 'request' : 'requests'}</button>{/if}
  <div class='table-scroll req-scroll' bind:this={scroller} {@attach fitViewport} onscroll={() => scroller.scrollTop || (fresh = 0)}>
    <table class='table no-reflow' role='grid' aria-label='Requests' aria-busy={!rows}>
      <thead>
        <tr><th>State</th><th class='num'>Started</th><th>Endpoint</th><th>Model</th><th class='c-hide'>Strategy</th>{#if showAccount}<th class='c-hide'>Account</th>{/if}<th class='num'>Status</th><th class='num'>Duration</th></tr>
      </thead>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (delegated row click and Enter; the rows are the grid's focus targets) -->
      <tbody
        use:rovingGrid={{ onMove: row => onselect(row.dataset.id!) }}
        onclick={(event) => {
          const id = rowId(event.target)
          if (id)
            onpick(id, false)
        }}
        {onkeydown}
      >
        {#if !rows}
          {#each { length: 8 }, index (index)}
            <tr><td colspan={columns}>{#if !index}<span class='sr-only'>Loading Requests…</span>{/if}<Skeleton /></td></tr>
          {/each}
        {:else}
          {#each rows as row (row.requestId)}
            {@const tone = httpTone(row.status)}
            {@const frozen = !app.live && isTicking(row)}
            <tr data-row data-id={row.requestId} tabindex='-1' aria-selected={row.requestId === selectedId}>
              <td class='c-state'><Tag value={row.state} domain='request' /></td>
              <td class='c-time num' title={new Date(row.startedAt).toLocaleString()}>{formatClockOrDate(row.startedAt, now)}</td>
              <td class='c-endpoint mono'><span class='muted'>{row.method}</span> {row.endpoint}</td>
              <td class='c-model mono'>
                {#if row.modelTransforms.length}<span class='muted' title='requested {row.requestedModel || '—'}'>↺</span>{/if}
                {@render orNil(row.effectiveModel || row.requestedModel)}
              </td>
              <td class='c-hide mono'>{@render orNil(row.selectedStrategy)}</td>
              {#if showAccount}<td class='c-hide'>{@render orNil(row.accountName)}</td>{/if}
              <td class={['c-status num mono', tone === 'warn' && 'fg-warn', tone === 'bad' && 'fg-bad']}>{@render orNil(row.status)}</td>
              <td class={['c-dur num nowrap', frozen && 'muted']}>{formatDuration(elapsed(row, now, fetchedAt))}{#if frozen}<span class='sr-only'>{PAUSED}</span>{/if}</td>
            </tr>
          {:else}
            <tr>
              <td class='empty-cell' colspan={columns}>
                {#if total}
                  <EmptyState title='No requests match this filter.'><button type='button' class='btn secondary sm' onclick={onclear}>Clear filter</button></EmptyState>
                {:else}
                  <EmptyState title='No requests yet.' hint='Point a client at {location.origin}/v1 (OpenAI) or {location.origin} (Anthropic). Requests appear here while Live is on.' />
                {/if}
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
  .req-list { position: relative; }
  /* max-height comes from fitViewport. */
  .req-scroll { overflow-anchor: auto; container-type: inline-size; }
  .req-new { position: absolute; top: 40px; left: 50%; z-index: 2; transform: translateX(-50%); box-shadow: var(--shadow-pop); }
  tr[data-row] > td { white-space: nowrap; }
  /* Model ids wrap only after a hyphen while the list is a table. */
  tr[data-row] > .c-model { white-space: normal; }

  /* ≤1100 the list narrows: Strategy and Account stay in the detail only. */
  @container (max-width: 759px) {
    .c-hide { display: none; }
  }

  /* A list too narrow for its six visible columns (≤560, and beside the detail below ~1250): two-line rows
     (tag, model, duration) / (time, endpoint, status), same markup. */
  @container (max-width: 619px) {
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    tr[data-row] {
      display: grid; grid-template-columns: minmax(84px, auto) minmax(0, 1fr) auto; gap: 2px var(--s-2); padding: var(--s-2) var(--s-3);
      grid-template-areas: 'state model dur' 'time endpoint status'; border-bottom: 1px solid var(--line);
    }
    tr[data-row] > td { height: auto; padding: 0; border: 0; }
    .c-state { grid-area: state; }
    .c-model { grid-area: model; overflow-wrap: anywhere; }
    .c-dur { grid-area: dur; }
    tr[data-row] > .c-time { grid-area: time; text-align: left; }
    .c-endpoint { grid-area: endpoint; overflow: hidden; text-overflow: ellipsis; }
    .c-status { grid-area: status; }
  }
</style>
