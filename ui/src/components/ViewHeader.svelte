<script lang='ts'>
  import type { Snippet } from 'svelte'

  // Common view header: the single h1 (programmatic focus target), meta on the baseline, actions right.
  interface Props { title: string, meta?: Snippet, actions?: Snippet }
  const { title, meta, actions }: Props = $props()
</script>

<header class='view-head'>
  <h1 id='view-h1' tabindex='-1'>{title}</h1>
  {#if meta}<div class='view-meta'>{@render meta()}</div>{/if}
  {#if actions}<div class='view-actions'>{@render actions()}</div>{/if}
</header>
