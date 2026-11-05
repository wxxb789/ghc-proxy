<script lang='ts'>
  import type { Snippet } from 'svelte'
  import type { DataScope } from '../lib/store.svelte.ts'
  import { app, faults } from '../lib/store.svelte.ts'
  import FaultStrip from './FaultStrip.svelte'
  import Tag from './Tag.svelte'

  interface Props {
    title: string
    /** Section id; the h2 id defaults to `<id>-h` (router `section=` focus target). */
    id?: string
    headingId?: string
    /** Table panels: no body padding. */
    flush?: boolean
    /** Shows this scope's fault strip under the header and a `stale` tag once data exists. */
    scope?: DataScope
    class?: string
    meta?: Snippet
    actions?: Snippet
    children: Snippet
  }

  const { title, id, headingId, flush = false, scope, class: className, meta, actions, children }: Props = $props()
  const uid = $props.id()
  const hid = $derived(headingId ?? `${id ?? uid}-h`)
  const stale = $derived(!!scope && !!faults[scope] && !!app.loadedAt[scope])
</script>

<section {id} class={['panel', flush && 'panel-flush', className]} aria-labelledby={hid}>
  <header class='panel-head'>
    <h2 id={hid} tabindex='-1'>{title}</h2>
    <div class='panel-meta'>
      {#if stale}<Tag value='stale' tone='warn' />{/if}
      {@render meta?.()}
    </div>
    {#if actions}<div class='panel-actions'>{@render actions()}</div>{/if}
  </header>
  {#if scope}<FaultStrip {scope} />{/if}
  <div class='panel-body'>{@render children()}</div>
</section>
