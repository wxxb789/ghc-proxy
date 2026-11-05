<script lang='ts'>
  import type { ToneKind } from '../lib/tone.ts'

  // 8×8 square state mark; the shape (filled / hollow / absent) carries meaning with the color.
  const { tone }: { tone: ToneKind | null } = $props()
</script>

{#if tone && tone !== 'none'}<span class='lamp lamp-{tone}'></span>{/if}
