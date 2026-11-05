<script lang='ts'>
  // 36 × 10 s buckets in the sparkline frame. Non-zero buckets use the state color when `tone` is set.
  const { buckets, tone }: { buckets: number[], tone?: 'bad' | 'warn' } = $props()
  const max = $derived(Math.max(1, ...buckets))
  const width = $derived(180 / Math.max(1, buckets.length))
</script>

<svg class={['spark', 'bars', tone && `bars-${tone}`]} viewBox='0 0 180 24' preserveAspectRatio='none' aria-hidden='true'>
  {#each buckets as value, index (index)}
    {@const height = value > 0 ? Math.max(1, (value / max) * 22) : 1}
    <rect class={{ zero: value <= 0 }} x={index * width} y={24 - height} width={width - 1} {height} />
  {/each}
</svg>
