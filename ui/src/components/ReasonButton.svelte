<script lang='ts'>
  import type { Snippet } from 'svelte'

  // Disabled-with-reason pattern (spec §4.1): aria-disabled, still focusable, visible reason, click is a no-op.
  interface Props {
    /** When set, the control is unavailable and this text explains why. */
    reason?: string | null
    onclick: () => void
    /** `secondary` | `danger` | `ghost` | `primary`, plus sizes like `sm`, `full`. */
    class?: string
    busy?: boolean
    /** Tooltip while available; the visible reason replaces it while unavailable. */
    title?: string
    children: Snippet
  }

  const { reason = null, onclick, class: className = 'secondary', busy = false, title, children }: Props = $props()
  const reasonId = $props.id()

  function click() {
    if (!reason && !busy)
      onclick()
  }
</script>

<button type='button' class='btn {className}' aria-disabled={reason ? 'true' : undefined} aria-busy={busy || undefined} disabled={busy}
        aria-describedby={reason ? reasonId : undefined} title={reason ? undefined : title} onclick={click}>{@render children()}</button>
{#if reason}<p id={reasonId} class='reason'>{reason}</p>{/if}
