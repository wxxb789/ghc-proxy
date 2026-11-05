<script lang='ts'>
  import { formatNumber } from '../lib/format.ts'

  type Runs = Array<Array<[number, number]>>
  interface Props {
    /** Contiguous runs of `[x 0–180, value]` (see `sparkRuns`); gaps break the line. */
    runs: Runs
    /** Optional dashed second series (Queue pending). */
    second?: Runs
    /** When set, renders the sr-only sentence `<label>, last <minutes> min: low …, high …, now ….` (`last minute` under one minute). */
    label?: string
    minutes?: number
  }

  const { runs, second = [], label, minutes = 0 }: Props = $props()
  const values = $derived(runs.flat().map(point => point[1]))
  const max = $derived(Math.max(1, ...values, ...second.flat().map(point => point[1])))
  const y = (value: number) => 23 - (value / max) * 22
  const points = (run: Array<[number, number]>) => run.map(([x, value]) => `${x.toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  const end = $derived(runs.at(-1)?.at(-1))
</script>

<svg class='spark' viewBox='0 0 180 24' preserveAspectRatio='none' aria-hidden='true'>
  <line class={['spark-base', values.length < 2 && 'spark-empty']} x1='0' y1='23.5' x2='180' y2='23.5' />
  {#if values.length >= 2}
    {#each second as run, index (index)}<polyline class='spark-second' points={points(run)} />{/each}
    {#each runs as run, index (index)}<polyline class='spark-line' points={points(run)} />{/each}
    {#if end}<line class='spark-dot' x1={end[0]} y1={y(end[1])} x2={end[0]} y2={y(end[1])} />{/if}
  {/if}
</svg>
{#if label && values.length}
  <span class='sr-only'>{label}, {minutes >= 1 ? `last ${minutes} min` : 'last minute'}: low {formatNumber(Math.min(...values))}, high {formatNumber(Math.max(...values))}, now {formatNumber(values.at(-1))}.</span>
{/if}
