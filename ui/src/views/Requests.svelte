<script lang='ts'>
  import type { StateFilter } from './requests/helpers.ts'
  import FaultStrip from '../components/FaultStrip.svelte'
  import Icon from '../components/Icon.svelte'
  import Segmented from '../components/Segmented.svelte'
  import ViewHeader from '../components/ViewHeader.svelte'
  import { clock, useClock } from '../lib/clock.svelte.ts'
  import { latencyStats } from '../lib/insights.ts'
  import { replaceParams, router } from '../lib/router.svelte.ts'
  import { app } from '../lib/store.svelte.ts'
  import { inState, isTicking, matchesQuery, STATE_LABEL } from './requests/helpers.ts'
  import RequestDetail from './requests/RequestDetail.svelte'
  import RequestInsights from './requests/RequestInsights.svelte'
  import RequestList from './requests/RequestList.svelte'

  const FILTERS = Object.keys(STATE_LABEL) as StateFilter[]

  const data = $derived(app.data.requests)
  const stateFilter = $derived((router.params.state ?? 'all') as StateFilter)
  const query = $derived(router.params.q ?? '')
  const searchedActive = $derived(data?.active.filter(row => matchesQuery(row, query)) ?? [])
  const searchedRecent = $derived(data?.recent.filter(row => matchesQuery(row, query)) ?? [])
  const shownActive = $derived(searchedActive.filter(row => inState(stateFilter, row, true)))
  const shownRecent = $derived(searchedRecent.filter(row => inState(stateFilter, row, false)))
  const shown = $derived(shownActive.concat(shownRecent))
  const options = $derived(FILTERS.map(value => ({
    value,
    label: STATE_LABEL[value],
    count: searchedActive.filter(row => inState(value, row, true)).length + searchedRecent.filter(row => inState(value, row, false)).length,
  })))
  const showAccount = $derived(new Set(data ? [...data.active, ...data.recent].flatMap(row => row.accountName ? [row.accountName] : []) : []).size >= 2)
  const p50 = $derived(data ? latencyStats(data.recent)?.p50 : undefined)
  // The context bar names one account, but the ring spans all of them.
  const allAccounts = $derived((app.data.overview?.auth.accounts.totalAccounts ?? 0) > 1)

  // Selection (legacy semantics over the visible rows): keep it while visible,
  // else the first visible row (active first), else null; mirrored to `?id=`.
  const selected = $derived(shown.find(row => row.requestId === app.selection.requestId) ?? shown[0] ?? null)
  // Declared first so a deep link or in-view hash change wins over the mirror below.
  $effect(() => {
    if (router.params.id)
      app.selection.requestId = router.params.id
  })
  $effect(() => {
    if (!data || router.view !== 'requests')
      return
    const id = selected?.requestId
    app.selection.requestId = id ?? null
    if (router.params.id !== id)
      replaceParams({ id })
  })

  // Running rows tick on the shared clock while Live is on; with Live off they freeze.
  const ticking = $derived(app.live && !!data?.active.some(isTicking))
  $effect(() => {
    if (ticking)
      return useClock()
  })
  let liveNow = $state(Date.now())
  $effect(() => {
    if (app.live)
      liveNow = clock.now
  })
  const fetchedAt = $derived(app.loadedAt.requests?.getTime() ?? 0)
  const now = $derived(Math.max(liveNow, fetchedAt))

  const narrow = () => !!window.matchMedia?.('(max-width: 900px)').matches

  /** Click (focus=false) or Enter (focus=true) on a row. ≤900 the detail sits below, so bring it into view. */
  function pick(id: string, focus: boolean) {
    app.selection.requestId = id
    const heading = document.getElementById('request-detail-h')
    if (focus)
      heading?.focus()
    if (narrow())
      heading?.scrollIntoView({ block: 'start' })
  }

  let searchInput: HTMLInputElement

  function clearSearch() {
    replaceParams({ q: undefined })
    searchInput.focus()
  }

  function onSearchKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key !== 'Escape')
      return
    if (query)
      replaceParams({ q: undefined })
    else
      event.currentTarget.blur()
  }
</script>

{#snippet meta()}
  <span id='request-count'>{#if data}{data.active.length} active / {data.recent.length} finished{/if}</span>
  {#if data}<span>· {data.capacity} finished max</span>{/if}
  {#if allAccounts}<span>· all accounts</span>{/if}
  {#if data && !app.live}<span class='paused-meta'>· paused</span>{/if}
{/snippet}

<ViewHeader title='Requests' {meta} />
<div class='toolbar req-tools'>
  <Segmented label='Request state' {options} value={stateFilter} onchange={value => replaceParams({ state: value === 'all' ? undefined : value })} />
  <div class='search'>
    <input bind:this={searchInput} type='search' placeholder='Filter requests' aria-label='Filter requests' autocomplete='off' value={query} oninput={event => replaceParams({ q: event.currentTarget.value })} onkeydown={onSearchKey} />
    {#if query}<button type='button' class='btn ghost icon-btn search-clear' aria-label='Clear filter' onclick={clearSearch}><Icon name='x' /></button>{/if}
  </div>
</div>
<FaultStrip scope='requests' />
{#if data && data.active.length + data.recent.length}
  <RequestInsights recent={shownRecent} active={shownActive} {now} filtered={stateFilter !== 'all' || !!query} />
{/if}
<div class='req-layout'>
  <RequestList
    rows={data ? shown : null}
    total={data ? data.active.length + data.recent.length : 0}
    selectedId={selected?.requestId}
    {showAccount}
    {now}
    {fetchedAt}
    onselect={id => app.selection.requestId = id}
    onpick={pick}
    onclear={() => replaceParams({ state: undefined, q: undefined })}
  />
  <RequestDetail
    request={selected}
    loading={!data}
    {p50}
    {now}
    {fetchedAt}
    onescape={() => document.querySelector<HTMLElement>('[data-row][aria-selected=true]')?.focus()}
  />
</div>

<style>
  .req-tools { justify-content: space-between; }
  .req-tools > :global(.segmented) { flex: none; }
  .req-tools .search { width: min(320px, 100%); }
  .req-layout { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: var(--s-4); align-items: start; }

  /* Above 900 px the rail's Live toggle already reads "Paused". */
  @media (min-width: 901px) {
    .paused-meta { display: none; }
  }

  @media (max-width: 900px) {
    .req-layout { grid-template-columns: minmax(0, 1fr); }
  }

  @media (max-width: 560px) {
    .req-tools .search { width: 100%; }
    .req-tools > :global(.segmented) { flex: 1 1 100%; }
  }
</style>
