<script lang='ts'>
  import type { DashboardModel } from '@contract'
  import type { StatusLine } from '../lib/account-actions.svelte.ts'
  import { untrack } from 'svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import FaultStrip from '../components/FaultStrip.svelte'
  import Icon from '../components/Icon.svelte'
  import Nil from '../components/Nil.svelte'
  import ReasonButton from '../components/ReasonButton.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Tag from '../components/Tag.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { rovingGrid } from '../lib/actions/rovingGrid.ts'
  import { selectValue } from '../lib/actions/selectValue.ts'
  import { copyInto } from '../lib/clipboard.ts'
  import { formatClock, formatNumber, modelCapabilities, modelCompatibilityLines, modelsTsv } from '../lib/format.ts'
  import { refreshMetadata } from '../lib/poller.svelte.ts'
  import { focusHeading, replaceParams, router } from '../lib/router.svelte.ts'
  import { app, faults, metadataUnavailableReason } from '../lib/store.svelte.ts'

  // Models (spec §5.4). Never Live-polled; filter, grouping and sort live in the URL.
  const LIMITS = [['context', 'max_context_window_tokens'], ['prompt', 'max_prompt_tokens'], ['output', 'max_output_tokens']] as const
  const NEGATIVE_RE = /\b(?:unavailable|no|none|passthrough)$/

  const selection = app.selection.models
  const all = $derived(app.data.models?.models)
  const account = $derived(app.data.overview?.auth.accounts.currentAccount)
  const query = $derived(router.params.q ?? '')
  const grouped = $derived(router.params.group !== '0')
  const descending = $derived(router.params.sort === 'desc')
  const needle = $derived(query.trim().toLowerCase())
  const shown = $derived((all ?? []).filter(model => !needle
    || [model.id, model.name, model.vendor, model.effective.defaultMessagesStrategy].some(value => value?.toLowerCase().includes(needle))))
  const vendorOf = (model: DashboardModel) => model.vendor || 'Unknown'
  // Vendor groups are always A-Z; the direction applies to `name || id` within a group (or the whole table).
  const groups = $derived.by(() => {
    const direction = descending ? -1 : 1
    const rows = [...shown].sort((left, right) => (grouped ? vendorOf(left).localeCompare(vendorOf(right)) : 0)
      || direction * String(left.name || left.id).localeCompare(String(right.name || right.id)))
    const list: Array<{ vendor: string, rows: DashboardModel[] }> = []
    for (const model of rows) {
      const vendor = grouped ? vendorOf(model) : ''
      const last = list.at(-1)
      if (last?.vendor === vendor)
        last.rows.push(model)
      else
        list.push({ vendor, rows: [model] })
    }
    return list
  })
  const selected = $derived((all ?? []).filter(model => selection.includes(model.id)))
  const shownSelected = $derived(shown.filter(model => selection.includes(model.id)).length)
  const allShownSelected = $derived(shown.length > 0 && shownSelected === shown.length)
  const status = $state<StatusLine>({ text: '', tone: '' })
  let filterInput = $state<HTMLInputElement>()

  // Selection survives filter and sort but is pruned to ids still on the server.
  $effect(() => {
    if (!all)
      return
    const ids = new Set(all.map(model => model.id))
    untrack(() => {
      const kept = selection.filter(id => ids.has(id))
      if (kept.length < selection.length)
        selection.splice(0, selection.length, ...kept)
    })
  })

  /** Every selection change clears `#model-copy-status`. */
  function select(ids: string[], on: boolean) {
    const rest = selection.filter(id => !ids.includes(id))
    selection.splice(0, selection.length, ...rest, ...(on ? ids : []))
    status.text = ''
  }

  /** Clear unmounts itself, so focus falls back to the view h1 (spec §8). */
  function clearSelection() {
    select([...selection], false)
    void focusHeading('view-h1')
  }

  const toggle = (id: string) => select([id], !selection.includes(id))

  function rowKeydown(event: KeyboardEvent, id: string) {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      toggle(id)
    }
  }

  const copy = (text: string, done: string) => copyInto(status, text, done)
  const copySelected = () => copy(modelsTsv(selected, location.origin), `Copied ${selected.length} model${selected.length === 1 ? '' : 's'}`)

  const setQuery = (value: string) => replaceParams({ q: value || undefined })

  function clearFilter() {
    setQuery('')
    filterInput?.focus()
  }

  // Esc clears the filter, then blurs it on a second press (spec §8.4).
  function filterKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape')
      return
    event.preventDefault()
    if (query)
      setQuery('')
    else
      filterInput?.blur()
  }
</script>

<div class={['models', selected.length > 0 && 'has-selection']}>
  <ViewHeader title='Models'>
    {#snippet meta()}
      <span id='model-count'>{#if all}{shown.length} of {all.length}{/if}</span>
      {#if account}<span class='muted'>· for <span class='mono'>{account}</span></span>{/if}
      {#if app.loadedAt.models}<span class='muted'>· loaded {formatClock(app.loadedAt.models)}</span>{/if}
      {#if all && faults.models}<Tag value='stale' tone='warn' />{/if}
    {/snippet}
  </ViewHeader>

  <div class='toolbar'>
    <div class='search'>
      <input bind:this={filterInput} id='model-filter' type='search' placeholder='Filter models' aria-label='Filter models' value={query}
             oninput={event => setQuery(event.currentTarget.value)} onkeydown={filterKeydown} />
      {#if query}<button type='button' class='btn ghost icon-btn search-clear' aria-label='Clear filter' onclick={clearFilter}><Icon name='x' /></button>{/if}
    </div>
    <!-- The router drops default values (`group=1`, `sort=asc`), so they leave the URL. -->
    <label class='check'>
      <input id='model-group-vendor' type='checkbox' checked={grouped} onchange={event => replaceParams({ group: event.currentTarget.checked ? '1' : '0' })} />Group vendor
    </label>
    <span class='select'>
      <select id='model-sort' aria-label='Order models by name' {@attach selectValue(descending ? 'desc' : 'asc')} onchange={event => replaceParams({ sort: event.currentTarget.value })}>
        <option value='asc'>Name A-Z</option>
        <option value='desc'>Name Z-A</option>
      </select>
    </span>
    <div class='selection-bar'>
      {#if selected.length}
        <span>{selected.length} selected</span>
        <button type='button' class='btn ghost' onclick={clearSelection}>Clear</button>
      {/if}
      {#if selected.length === 1}
        <button type='button' class='btn secondary' onclick={() => copy(selected[0]!.id, 'Copied model ID')}>Copy ID</button>
      {/if}
      <button id='copy-models' type='button' class='btn secondary' disabled={!selected.length} onclick={copySelected}>
        <Icon name='copy' />Copy selected ({selected.length})
      </button>
      <p id='model-copy-status' role='status' aria-live='polite' class={['status-line', status.text && `is-${status.tone}`]}>
        {#if status.text}<Icon name={status.tone === 'ok' ? 'check' : 'x'} />{status.text}{/if}
      </p>
    </div>
  </div>

  <section class='panel panel-flush' aria-label='Model catalog'>
    <FaultStrip scope='models' />
    {#if all || !faults.models}
      <div class='table-scroll'>
        <table class='table catalog' role='grid' aria-label='Models' aria-multiselectable='true' aria-busy={!all || undefined} use:rovingGrid>
          <thead>
            <tr>
              <th class='sel'>
                <span class='check-cell'>
                  <input type='checkbox' aria-label='Select all shown models' disabled={!shown.length} checked={allShownSelected}
                         indeterminate={shownSelected > 0 && !allShownSelected} onchange={() => select(shown.map(model => model.id), !allShownSelected)} />
                </span>
              </th>
              <th class='model'>Model</th>
              <th>Vendor</th>
              <th>Messages route</th>
              <th>Upstream endpoints</th>
              <th>Limits</th>
              <th>Capabilities</th>
              <th>Proxy compatibility</th>
            </tr>
          </thead>
          <tbody>
            {#if !all}
              {#each { length: 10 }, index (index)}<tr><td colspan='8'><Skeleton /></td></tr>{/each}
            {:else if !all.length}
              <tr><td colspan='8' class='empty-cell'>
                <EmptyState icon='models' title={account ? `No models loaded for ${account}.` : 'No models loaded.'} hint='Models appear after the Copilot catalog loads.'>
                  <ReasonButton reason={metadataUnavailableReason()} busy={app.busy.metadata} onclick={refreshMetadata}><Icon name='refresh' />Refresh metadata</ReasonButton>
                </EmptyState>
              </td></tr>
            {:else if !shown.length}
              <tr><td colspan='8' class='empty-cell'>
                <EmptyState title={`No models match "${query.trim()}".`}>
                  <button type='button' class='btn ghost' onclick={clearFilter}>Clear filter</button>
                </EmptyState>
              </td></tr>
            {:else}
              {#each groups as group (group.vendor)}
                {#if grouped}
                  <tr class='group vendor-group'><th colspan='8' scope='colgroup'><span>{group.vendor}<span class='muted'>{` · ${group.rows.length}`}</span></span></th></tr>
                {/if}
                <!-- Index keys: the server does not guarantee unique ids or endpoints, and duplicate keys throw. -->
                {#each group.rows as model, index (index)}
                  {@const on = selection.includes(model.id)}
                  {@const limits = model.upstream.capabilities.limits}
                  <tr data-row tabindex='-1' aria-selected={on} onclick={() => toggle(model.id)} onkeydown={event => rowKeydown(event, model.id)}>
                    <td class='sel'>
                      <span class='check-cell'>
                        <input type='checkbox' aria-label='Select {model.id}' tabindex='-1' checked={on}
                               onclick={(event) => {
                                 event.stopPropagation()
                                 toggle(model.id)
                               }} />
                      </span>
                    </td>
                    <td class='model'>
                      <span class='line mono strong'>{model.id}</span>
                      <span class='sub'>{model.name} {#if model.preview}<Tag kind='outline' value='preview' />{/if}</span>
                    </td>
                    <td data-label='Vendor'>{model.vendor}<span class='sub mono'>{model.version}</span></td>
                    <td data-label='Messages route'><Tag kind='mono' value={model.effective.defaultMessagesStrategy} /></td>
                    <td class='endpoints' data-label='Upstream endpoints'>
                      {#each model.upstream.endpoints as endpoint, position (position)}<span class='line mono'>{endpoint}</span>{:else}<Nil />{/each}
                    </td>
                    <td data-label='Limits'>
                      <span class='limits'>
                        {#each LIMITS as [label, key] (label)}
                          <span class='muted'>{label}</span><span class='num'>{formatNumber(limits[key])}</span>
                        {/each}
                      </span>
                    </td>
                    <td data-label='Capabilities'>
                      <span class='caps'>{#each modelCapabilities(model) as capability (capability)}<Tag kind='mono' value={capability} />{:else}<Nil />{/each}</span>
                    </td>
                    <td class='compat' data-label='Proxy compatibility'>
                      {#each modelCompatibilityLines(model) as line (line)}<span class={['line', NEGATIVE_RE.test(line) && 'muted']}>{line}</span>{/each}
                    </td>
                  </tr>
                {/each}
              {/each}
            {/if}
          </tbody>
        </table>
        {#if !all}<p class='sr-only'>Loading models…</p>{/if}
      </div>
    {/if}
  </section>
</div>

<style>
  /* Same section gap as views whose sections sit directly in <main>. */
  .models { display: grid; gap: var(--s-6); }
  .models > * { min-width: 0; }
  .toolbar { align-items: flex-start; }
  .search { flex: 0 1 320px; }
  .selection-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--s-1) var(--s-2); margin-left: auto; }
  .selection-bar .status-line { flex-basis: 100%; justify-content: flex-end; }
  /* Fits the 1440 main column (1166 px inside the panel); narrower widths scroll sideways. */
  .catalog { min-width: 1160px; }
  .catalog td { white-space: nowrap; }
  .catalog .sel { width: 52px; }
  /* Select + Model stay pinned while the table scrolls sideways; pinned cells repaint the row states. */
  .catalog :is(.sel, .model) { position: sticky; left: 0; z-index: 1; background: var(--bg-1); }
  .catalog .model { left: 52px; }
  .catalog th:is(.sel, .model) { z-index: 2; }
  .catalog tbody tr:hover > :is(.sel, .model) { background: var(--bg-2); }
  .catalog tr[aria-selected='true'] > :is(.sel, .model) { background: var(--accent-tint); }
  .catalog tr[aria-selected='true'] > .sel { box-shadow: inset 2px 0 0 var(--accent); }
  .vendor-group span { position: sticky; left: 16px; }
  .limits { display: inline-grid; grid-template-columns: auto auto; column-gap: var(--s-3); }
  .caps { display: flex; flex-wrap: wrap; gap: var(--s-1); max-width: 260px; }

  @media (max-width: 900px) {
    .search { flex-basis: 100%; }
    .selection-bar { margin-left: 0; justify-content: flex-start; }
    .selection-bar .status-line { justify-content: flex-start; }
  }

  @media (max-width: 560px) {
    .has-selection { padding-bottom: 56px; }
    .selection-bar {
      position: fixed; bottom: 0; inset-inline: 0; z-index: 30; min-height: 56px; padding: var(--s-2) var(--s-3);
      background: var(--bg-3); border-top: 1px solid var(--line-strong);
    }
    .models:not(.has-selection) .selection-bar { display: none; }
    .catalog { min-width: 0; }
    .catalog td { white-space: normal; }
    /* Cards: checkbox beside the id, then name, vendor, route, limits, capabilities, endpoints, compatibility. */
    .catalog tbody tr[data-row] { grid-template-columns: 32px minmax(0, 1fr); }
    .catalog tbody tr[data-row] > td { grid-column: 2; position: static; background: none; }
    .catalog tbody tr[data-row] > .sel { grid-column: 1; grid-row: 1; width: auto; box-shadow: none; }
    .catalog .endpoints { order: 1; }
    .catalog .compat { order: 2; }
    /* The vendor group row stays a flush band, not a card. */
    .catalog tbody tr.vendor-group { padding: 0; border-bottom: 0; }
    .catalog tr.vendor-group > th { display: flex; align-items: center; padding: 0 12px; }
  }
</style>
