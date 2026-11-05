<script lang='ts'>
  // Static loading blocks (no shimmer). Shown only before a scope's first success.
  interface Props {
    /** Number of text bars, cycling 80/60/40 % widths. */
    lines?: number
    /** One 28 px readout block instead of text bars. */
    readout?: boolean
  }

  const { lines = 1, readout = false }: Props = $props()
  const widths = ['w80', 'w60', 'w40']
</script>

{#if readout}
  <span class='skel skel-readout' aria-hidden='true'></span>
{:else}
  {#each { length: lines }, index (index)}<span class='skel {widths[index % 3]}' aria-hidden='true'></span>{/each}
{/if}
