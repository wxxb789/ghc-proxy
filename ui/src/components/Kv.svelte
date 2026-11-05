<script lang='ts'>
  import type { Snippet } from 'svelte'
  import Nil from './Nil.svelte'

  // One row of a `<dl class='kv'>`. Pass `value` for plain text or children for structured content.
  interface Props { label: string, value?: string | number | null, mono?: boolean, title?: string, children?: Snippet }
  const { label, value, mono = false, title, children }: Props = $props()
</script>

<div class='kv-row'>
  <dt>{label}</dt>
  <dd class={{ mono }} {title}>
    {#if children}{@render children()}{:else if value !== undefined && value !== null && value !== ''}{value}{:else}<Nil />{/if}
  </dd>
</div>
