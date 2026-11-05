<script lang='ts'>
  import type { Snippet } from 'svelte'
  import type { IconName } from './Icon.svelte'
  import Icon from './Icon.svelte'

  // Centered empty state; `children` holds an optional action or copyable snippet.
  interface Props { title: string, hint?: string, icon?: IconName, children?: Snippet }
  const { title, hint, icon, children }: Props = $props()
</script>

<div class='empty'>
  {#if icon}<Icon name={icon} class='icon-lg' />{/if}
  <p class='empty-title'>{title}</p>
  {#if hint}<p class='empty-hint'>{hint}</p>{/if}
  {@render children?.()}
</div>
