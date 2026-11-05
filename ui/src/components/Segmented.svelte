<script lang='ts' generics='T extends string'>
  // Radiogroup with roving tabindex; ←/→ move and select (theme, Requests state filter).
  interface Option { value: T, label: string, count?: number }
  interface Props { label: string, options: Option[], value: T, onchange: (value: T) => void, class?: string }

  const { label, options, value, onchange, class: className }: Props = $props()
  let group: HTMLElement

  function onkeydown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step)
      return
    event.preventDefault()
    const index = (options.findIndex(option => option.value === value) + step + options.length) % options.length
    onchange(options[index]!.value)
    group.querySelectorAll<HTMLElement>('[role=radio]')[index]?.focus()
  }
</script>

<div bind:this={group} class={['segmented', className]} role='radiogroup' aria-label={label} tabindex='-1' {onkeydown}>
  {#each options as option (option.value)}
    <button type='button' role='radio' aria-checked={option.value === value} tabindex={option.value === value ? 0 : -1} onclick={() => onchange(option.value)}>
      {option.label} {#if option.count !== undefined}<span class='count'>{option.count}</span>{/if}
    </button>
  {/each}
</div>
