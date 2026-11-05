<script lang='ts'>
  import type { CloseFocus } from './IssuesPopover.svelte'
  import Icon from '../components/Icon.svelte'
  import { health } from '../lib/health.svelte.ts'
  import { app } from '../lib/store.svelte.ts'
  import IssuesPopover from './IssuesPopover.svelte'

  let button = $state<HTMLButtonElement>()
  const loud = $derived(health.issues.filter(issue => issue.tone !== 'info'))
  const connectionLabel = $derived(app.connection.state === 'lost' ? 'Connection lost' : app.connection.state === 'blocked' ? 'Access denied' : '')
  const count = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`
  const label = $derived.by(() => {
    if (connectionLabel)
      return loud.length > 1 ? `${connectionLabel} · ${count(loud.length - 1)}` : connectionLabel
    return loud.length ? count(loud.length) : 'No issues'
  })

  /**
   * `invoker`: back to this button. `view`: the view h1 holds focus until a
   * followed link's heading takes it. `outside`: after an outside click, only
   * when that click left focus nowhere (spec §8.5).
   */
  function close(focus: CloseFocus = 'invoker') {
    app.ui.issuesOpen = false
    if (focus === 'invoker')
      button?.focus()
    else if (focus === 'view')
      document.getElementById('view-h1')?.focus({ preventScroll: true })
    else
      setTimeout(() => (document.activeElement ?? document.body) === document.body && button?.focus())
  }
</script>

<div class='issues-anchor'>
  <button bind:this={button} type='button' class={['btn', 'issues-btn', health.worst ? `tone-${health.worst}` : 'ghost']}
          aria-expanded={app.ui.issuesOpen} aria-controls='issues-popover' onclick={() => app.ui.issuesOpen = !app.ui.issuesOpen}>
    <Icon name={!health.worst ? 'check' : health.worst === 'bad' ? 'x' : 'triangle'} />{label}
  </button>
  {#if app.ui.issuesOpen && button}<IssuesPopover {button} onclose={close} />{/if}
</div>
