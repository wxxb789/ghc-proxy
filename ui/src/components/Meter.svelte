<script lang='ts'>
  // Percentage meter (spec §4.8). The fill is SVG geometry, so no inline style is needed.
  interface Props {
    /** 0–100; clamped. */
    value: number
    label: string
    /** Quota tone: `ok`/null render neutral ink; warn and bad use the tone color. */
    tone?: 'ok' | 'warn' | 'bad' | null
    /** Width class from the caller, e.g. `meter-80`. */
    class?: string
  }

  const { value, label, tone = null, class: className }: Props = $props()
  const pct = $derived(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)))
</script>

<span class={['meter', tone && tone !== 'ok' && `meter-${tone}`, className]} role='meter' aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
  <svg viewBox='0 0 100 1' preserveAspectRatio='none' aria-hidden='true'><rect width={pct} height='1' /></svg>
</span>
