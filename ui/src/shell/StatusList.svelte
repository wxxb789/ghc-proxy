<script lang='ts'>
  import type { ToneKind } from '../lib/tone.ts'
  import Lamp from '../components/Lamp.svelte'
  import { clock } from '../lib/clock.svelte.ts'
  import { formatCooldowns, formatDuration, formatPercent } from '../lib/format.ts'
  import { app } from '../lib/store.svelte.ts'
  import { quotaTone, statusText, toneOf } from '../lib/tone.ts'

  interface Row { label: string, value: string, tone: ToneKind | null }

  const connection = $derived.by((): Row => {
    const { state, rttMs, lostSince } = app.connection
    const row = (value: string, tone: ToneKind): Row => ({ label: 'Connection', value, tone })
    // Live off wins over lost/retrying: nothing polls, so nothing is being retried.
    if (state === 'blocked')
      return row('access denied', 'bad')
    if (!app.live)
      return row('paused', 'hollow')
    if (state === 'lost')
      return row(`lost ${formatDuration(Math.max(0, clock.now - (lostSince?.getTime() ?? clock.now)))}`, 'bad')
    if (state === 'connecting')
      return row('connecting', 'hollow')
    return state === 'reconnecting' ? row('retrying', 'warn') : row(`2 s · ${rttMs ?? '—'} ms`, 'ok')
  })

  const rows = $derived.by((): Row[] => {
    const overview = app.data.overview
    if (!overview)
      return ['Upstream', 'Copilot', 'Premium quota', 'Queue', 'Cooldown'].map(label => ({ label, value: '—', tone: 'hollow' }))
    const { auth, quota, activity } = overview
    const queue = activity.upstreamQueue
    const premium = quota.premiumInteractions
    const quotaStatus = quota.status === 'ok' && !premium ? 'unavailable' : quota.status
    const quotaRow: Row = quotaStatus === 'ok' && premium
      ? { label: 'Premium quota', value: premium.unlimited ? 'unlimited' : formatPercent(premium.percentRemaining), tone: quotaTone(premium) }
      : { label: 'Premium quota', value: statusText(quotaStatus), tone: toneOf('health', quotaStatus) }
    const cooldowns = formatCooldowns(queue)
    return [
      // Provider only: `overview.status` is the Copilot verdict, which the Copilot row shows.
      { label: 'Upstream', value: auth.upstream === 'm365' ? 'Microsoft 365' : 'GitHub', tone: 'hollow' },
      ...(auth.upstream === 'm365' ? [] : [{ label: 'GitHub', value: statusText(auth.github.status), tone: toneOf('health', auth.github.status) }]),
      { label: 'Copilot', value: statusText(auth.copilot.status), tone: toneOf('health', auth.copilot.status) },
      quotaRow,
      { label: 'Queue', value: `${queue.active} / ${queue.concurrency} · ${queue.pending} pending`, tone: queue.maxPending > 0 && queue.pending >= queue.maxPending ? 'bad' : queue.pending > 0 ? 'warn' : 'ok' },
      { label: 'Cooldown', value: cooldowns, tone: cooldowns === 'none' ? 'hollow' : 'warn' },
    ]
  })
</script>

<section class='status' aria-labelledby='status-h'>
  <h2 id='status-h' class='sr-only'>System status</h2>
  <dl>
    {#each [connection, ...rows] as row (row.label)}
      <div class='status-row'><dt><Lamp tone={row.tone} />{row.label}</dt><dd title={row.value}>{row.value}</dd></div>
    {/each}
  </dl>
</section>
