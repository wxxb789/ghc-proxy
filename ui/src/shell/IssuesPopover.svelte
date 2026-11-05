<script lang='ts' module>
  export type CloseFocus = 'invoker' | 'view' | 'outside'
</script>

<script lang='ts'>
  import IssueRow from '../components/IssueRow.svelte'
  import { health } from '../lib/health.svelte.ts'

  // Lists every issue (info included). Esc, an outside click or an action closes it (spec §2.5.3, §8.5).
  const { button, onclose }: { button: HTMLElement, onclose: (focus?: CloseFocus) => void } = $props()
  let popover: HTMLElement

  // First action, else the first row, else the popover itself (no issues), so Esc works.
  $effect(() => {
    (popover.querySelector<HTMLElement>('.issue .btn') ?? popover.querySelector<HTMLElement>('.issue') ?? popover).focus()
  })

  function onpointerdown(event: PointerEvent) {
    const target = event.target as Node
    if (!popover.contains(target) && !button.contains(target))
      onclose('outside')
  }

  // On the document so Esc still works after a poll removes the focused row (focus falls to <body>).
  function onkeydown(event: KeyboardEvent) {
    const target = event.target as Node
    if (event.key === 'Escape' && (target === document.body || popover.contains(target) || button.contains(target)))
      onclose()
  }
</script>

<svelte:document {onpointerdown} {onkeydown} />

<div bind:this={popover} id='issues-popover' class='popover' role='dialog' aria-label='Issues' tabindex='-1'>
  {#if health.issues.length}
    <ul class='issue-list'>
      {#each health.issues as issue (issue.id)}<IssueRow {issue} onaction={action => onclose(action.kind === 'link' ? 'view' : 'invoker')} />{/each}
    </ul>
  {:else}
    <p class='popover-empty'>No issues.</p>
  {/if}
</div>
