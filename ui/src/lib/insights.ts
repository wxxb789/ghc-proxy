// Derived health (spec §6): pure functions over last-known data. Nothing
// here fetches, stores or schedules.
import type { AccountsResponse, DashboardAccount, M365DashboardState, ObservedRequest, OverviewResponse } from '@contract'
import type { Sample } from './samples.ts'
import type { AccountsMode, ConnectionState, Faults, Scope } from './store.svelte.ts'
import type { ToneKind } from './tone.ts'
import { formatClock, formatDate, formatPercent, plural } from './format.ts'
import { sumDelta } from './samples.ts'
import { SCOPE_LABEL } from './store.svelte.ts'
import { quotaTone } from './tone.ts'

export type IssueTone = 'bad' | 'warn' | 'info'

export interface IssueAction {
  label: string
  /** link: follow `href`; retry: reload `scope`; refresh: POST /refresh (availability rules apply); dismiss: hide issue `id`. */
  kind: 'link' | 'retry' | 'refresh' | 'dismiss'
  href?: string
  scope?: Scope
  id?: string
}

export interface Issue {
  id: string
  tone: IssueTone
  title: string
  body?: string
  actions: IssueAction[]
  /** Fault bookkeeping: first failure and failure count. */
  since?: Date
  count?: number
  /** Set when the rule reads last-known accounts or M365 data. */
  asOf?: Date
}

export interface IssueInputs {
  now: number
  /** `location.href`, for the 421 `Open on localhost` link. */
  href: string
  overview: OverviewResponse | null
  overviewAt: Date | null
  samples: readonly Sample[]
  faults: Faults
  connection: { state: ConnectionState, blockedStatus: number, blockedMessage: string }
  accountsMode: AccountsMode
  accounts: AccountsResponse | null
  accountsAt: Date | null
  m365: M365DashboardState | null
  m365At: Date | null
  restartedAt: Date | null
  dismissed: readonly string[]
}

const FIVE_MINUTES = 300_000
const OPEN_ACCOUNTS: IssueAction = { label: 'Open Accounts', kind: 'link', href: '#/accounts' }
const VIEW_QUOTA: IssueAction = { label: 'View quota', kind: 'link', href: '#/overview?section=quota' }
const REFRESH_METADATA: IssueAction = { label: 'Refresh metadata', kind: 'refresh' }
const DATA_SCOPES = ['overview', 'accounts', 'models', 'behavior', 'requests'] as const

/** `/dashboard#/overview` on `localhost`, same protocol and port. */
export function localhostDashboardUrl(href: string): string {
  const url = new URL('/dashboard#/overview', href)
  url.hostname = 'localhost'
  return url.href
}

/** Last-known account health for the Accounts nav lamp; stale quota warns here only, never in rule A1. */
export function accountAttention(account: DashboardAccount, m365: M365DashboardState | null): 'bad' | 'warn' | null {
  const m365Upstream = account.upstream === 'm365'
  if (account.github.status === 'missing' || account.copilot.status === 'missing'
    || (!m365Upstream && account.quota.status === 'unavailable')
    || (m365Upstream && m365?.availability?.status === 'unavailable')) {
    return 'bad'
  }
  return account.copilot.status === 'degraded' || account.quota.status === 'stale' ? 'warn' : null
}

/** Rule A1's condition (spec §6.1): attention minus routine stale quota. */
function needsAttention(account: DashboardAccount, m365: M365DashboardState | null): boolean {
  return accountAttention(account, m365) === 'bad' || account.copilot.status === 'degraded'
}

/** Worst account attention across every target (nav badge). */
export function accountsAttention(accounts: AccountsResponse | null, m365: M365DashboardState | null): 'bad' | 'warn' | null {
  let worst: 'bad' | 'warn' | null = null
  for (const account of accounts?.accounts ?? []) {
    const attention = accountAttention(account, m365)
    if (attention === 'bad')
      return 'bad'
    worst ??= attention
  }
  return worst
}

function healthIssues(input: IssueInputs, overview: OverviewResponse, bad: Issue[], warn: Issue[], info: Issue[]): void {
  const { auth, quota, activity } = overview
  const account = auth.accounts.currentAccount
  const m365Upstream = auth.upstream === 'm365'
  const routing = input.accountsMode === 'routing'
  const premium = quota.premiumInteractions
  const queue = activity.upstreamQueue

  if (!m365Upstream && auth.github.status === 'missing') {
    bad.push({
      id: 'H1',
      tone: 'bad',
      title: `GitHub isn't signed in for ${account}`,
      body: `Requests can't reach Copilot until this account is authenticated.${routing ? '' : ' Run "ghc-proxy auth" in a terminal.'}`,
      actions: routing ? [OPEN_ACCOUNTS] : [],
    })
  }
  if (auth.copilot.status === 'missing')
    bad.push({ id: 'H2', tone: 'bad', title: `Copilot isn't connected for ${account}`, body: 'No Copilot token is available.', actions: [OPEN_ACCOUNTS] })
  if (premium && !premium.unlimited && premium.remaining === 0 && !premium.overagePermitted)
    bad.push({ id: 'Q1', tone: 'bad', title: 'Premium requests are used up', body: quota.resetDate ? `Resets ${formatDate(quota.resetDate)}.` : undefined, actions: [VIEW_QUOTA] })
  if (queue.maxPending > 0 && queue.pending >= queue.maxPending)
    bad.push({ id: 'R3', tone: 'bad', title: 'The upstream queue is full', body: `${queue.pending} of ${queue.maxPending} waiting.`, actions: [] })

  if (auth.copilot.status === 'degraded') {
    const cause = input.m365?.availability?.status === 'unavailable' ? input.m365.availability.cause : undefined
    const reasons = m365Upstream
      ? [cause ? `Microsoft 365 target is unavailable: ${cause}` : '']
      : [auth.copilot.modelsLoaded ? '' : 'Models couldn\'t be loaded.', auth.copilot.lastRefreshSucceeded === false ? 'The last token refresh failed.' : '']
    warn.push({
      id: 'H3',
      tone: 'warn',
      title: 'Copilot is degraded',
      body: reasons.filter(Boolean).join(' ') || 'Copilot reported a degraded state.',
      actions: [m365Upstream ? { label: 'Open M365 settings', kind: 'link', href: '#/accounts?section=m365' } : REFRESH_METADATA],
      asOf: m365Upstream && cause ? input.m365At ?? undefined : undefined,
    })
  }
  // Q2: ≤20 % left while Q1 does not apply (remaining > 0, or overage permitted).
  const premiumTone = quotaTone(premium)
  if (premium && (premiumTone === 'warn' || premiumTone === 'bad') && (premium.remaining > 0 || premium.overagePermitted)) {
    const resets = quota.resetDate ? ` · resets ${formatDate(quota.resetDate)}` : ''
    warn.push({ id: 'Q2', tone: 'warn', title: 'Premium requests are running low', body: `${formatPercent(premium.percentRemaining)} left${resets}`, actions: [VIEW_QUOTA] })
  }
  if (!m365Upstream && quota.status === 'unavailable')
    warn.push({ id: 'Q3', tone: 'warn', title: 'Quota couldn\'t be loaded', body: 'ghc-proxy will retry within a minute.', actions: [REFRESH_METADATA] })

  // R1: failure spike over the last 5 minutes; decays as failures age out of the window.
  const since = input.now - FIVE_MINUTES
  const failed = sumDelta(input.samples, 'failed', since)
  const completed = sumDelta(input.samples, 'completed', since)
  if (failed >= 3 && completed > 0 && failed / completed >= 0.2) {
    const start = input.samples.find(sample => sample.t >= since)
    warn.push({
      id: 'R1',
      tone: 'warn',
      title: `${failed} of ${completed} requests in the last 5 min failed`,
      body: start ? `Since ${formatClock(start.t, false)}.` : undefined,
      actions: [{ label: 'Review failures', kind: 'link', href: '#/requests?state=failed' }],
    })
  }
  const lastThree = input.samples.slice(-3)
  if (lastThree.length === 3 && !lastThree[1]!.gap && !lastThree[2]!.gap && lastThree.every(sample => sample.qPending > 0))
    warn.push({ id: 'R2', tone: 'warn', title: 'Requests are queueing', body: `${queue.pending} waiting for ${queue.concurrency} upstream slots.`, actions: [] })
  if (queue.accountCooldown)
    warn.push({ id: 'R4', tone: 'warn', title: 'Upstream cooldown active', body: 'Copilot asked this account to back off; requests wait automatically.', actions: [] })

  if (quota.status === 'stale')
    info.push({ id: 'Q4', tone: 'info', title: 'Quota may be out of date', body: `Last fetched ${formatDate(quota.fetchedAt)}.`, actions: [] })
  if (queue.modelCooldowns > 0)
    info.push({ id: 'R5', tone: 'info', title: `${plural(queue.modelCooldowns, 'model cooldown')} active`, actions: [] })
}

/**
 * Every current issue, ordered: connection, then bad, warn and info in rule
 * order (spec §6.1). An issue exists only while its condition holds.
 */
export function deriveIssues(input: IssueInputs): Issue[] {
  const bad: Issue[] = []
  const warn: Issue[] = []
  const info: Issue[] = []
  const { connection, overview } = input

  // C1 has no body: the connection strip already says whether it retries or Live is paused.
  if (connection.state === 'lost')
    bad.push({ id: 'C1', tone: 'bad', title: 'Can\'t reach ghc-proxy', actions: [{ label: 'Retry now', kind: 'retry', scope: 'overview' }] })
  if (connection.state === 'blocked') {
    bad.push({
      id: 'C2',
      tone: 'bad',
      title: 'Access denied',
      body: connection.blockedMessage,
      actions: connection.blockedStatus === 421 ? [{ label: 'Open on localhost', kind: 'link', href: localhostDashboardUrl(input.href) }] : [],
    })
  }

  for (const scope of DATA_SCOPES) {
    const fault = input.faults[scope]
    if (fault) {
      warn.push({
        id: `F1:${scope}`,
        tone: 'warn',
        title: `Couldn't load ${SCOPE_LABEL[scope]}`,
        body: fault.message,
        since: fault.since,
        count: fault.count,
        actions: [{ label: 'Retry', kind: 'retry', scope }],
      })
    }
  }
  const metadata = input.faults.metadata
  if (metadata) {
    warn.push({
      id: 'F2',
      tone: 'warn',
      title: 'Metadata refresh incomplete',
      body: metadata.message,
      since: metadata.since,
      count: metadata.count,
      actions: [{ label: 'Retry refresh', kind: 'refresh' }, { label: 'Dismiss', kind: 'dismiss', id: 'F2' }],
    })
  }

  if (overview)
    healthIssues(input, overview, bad, warn, info)

  const current = overview?.auth.accounts.currentAccount
  const others = (input.accounts?.accounts ?? []).filter(account => account.name !== current && needsAttention(account, input.m365))
  if (others.length) {
    const names = others.slice(0, 3).map(account => account.name).join(', ')
    warn.push({
      id: 'A1',
      tone: 'warn',
      title: `${plural(others.length, 'other account')} ${others.length === 1 ? 'needs' : 'need'} attention`,
      body: others.length > 3 ? `${names} +${others.length - 3}` : names,
      actions: [OPEN_ACCOUNTS],
      asOf: input.accountsAt ?? undefined,
    })
  }

  const restart = input.restartedAt
  const restartId = restart && `P1:${restart.getTime()}`
  if (restart && restartId && input.now - restart.getTime() < FIVE_MINUTES && !input.dismissed.includes(restartId)) {
    info.push({
      id: restartId,
      tone: 'info',
      title: `ghc-proxy restarted at ${formatClock(restart)}`,
      body: 'Live charts started over.',
      actions: [{ label: 'Dismiss', kind: 'dismiss', id: restartId }],
    })
  }
  return [...bad, ...warn, ...info]
}

/** The worst tone that may tint the Issues button; info alone keeps it quiet. */
export function worstTone(issues: readonly Issue[]): 'bad' | 'warn' | null {
  return issues.some(issue => issue.tone === 'bad') ? 'bad' : issues.some(issue => issue.tone === 'warn') ? 'warn' : null
}

/** Overview summary sentence for the all-clear state (spec §6.2); Overview hides it while any issue is loud. */
export function summarySentence(overview: OverviewResponse | null): { tone: ToneKind, text: string } {
  if (!overview)
    return { tone: 'hollow', text: 'Connecting to ghc-proxy…' }
  // Identity, reset date and plan live in the panels below; only the GitHub premium headroom is added here.
  const { quota } = overview
  const premium = overview.auth.upstream === 'm365' ? undefined : quota.premiumInteractions
  if (premium?.unlimited)
    return { tone: 'ok', text: 'All normal. Premium requests are unlimited.' }
  if (premium && Number.isFinite(premium.percentRemaining) && quota.status !== 'not_applicable' && quota.status !== 'unavailable')
    return { tone: 'ok', text: `All normal. ${formatPercent(premium.percentRemaining)} of premium requests left.` }
  return { tone: 'ok', text: 'All normal.' }
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

export interface LatencyStats { n: number, p50: number, p95: number, max: number }

/** Latency over completed rows; `null` below 5 samples. */
export function latencyStats(rows: readonly ObservedRequest[]): LatencyStats | null {
  const sorted = rows.filter(row => row.state === 'completed').map(row => row.durationMs).sort((a, b) => a - b)
  if (sorted.length < 5)
    return null
  return { n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1)! }
}

export interface Share { label: string, count: number, pct: number }

/** Count desc, label asc; beyond `top` the rest folds into `k others`. Floored percentages never sum above 100. */
export function shares(labels: readonly string[], top = Infinity): Share[] {
  const counts = new Map<string, number>()
  for (const label of labels)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const rest = sorted.splice(top)
  if (rest.length)
    sorted.push([plural(rest.length, 'other'), rest.reduce((sum, [, count]) => sum + count, 0)])
  return sorted.map(([label, count]) => ({ label, count, pct: Math.floor((count / labels.length) * 100) }))
}

export interface RingInsights {
  finished: number
  spanMs: number | null
  latency: LatencyStats | null
  mix: { ok: number, client: number, server: number, aborted: number, errorRate: number | null }
  topModels: Share[]
  strategies: Share[]
  /** Only when at least two distinct accounts appear. */
  accounts: Share[] | null
}

/** Requests insights over the shown rows (spec §6.4): finished `recent` rows, plus aborted `active` rows for the status mix. */
export function ringInsights(recent: readonly ObservedRequest[], active: readonly ObservedRequest[], now: number): RingInsights {
  const mix = { ok: 0, client: 0, server: 0, aborted: 0, errorRate: null as number | null }
  const terminal = [...recent, ...active.filter(row => row.state === 'aborted')]
  for (const row of terminal) {
    if (row.state === 'aborted')
      mix.aborted++
    else if ((row.status ?? 0) >= 500 || (row.state === 'failed' && row.status === undefined))
      mix.server++
    else if ((row.status ?? 0) >= 400)
      mix.client++
    else
      mix.ok++
  }
  if (terminal.length)
    mix.errorRate = ((mix.client + mix.server) / terminal.length) * 100
  const starts = recent.map(row => Date.parse(row.startedAt)).filter(Number.isFinite)
  const accountShares = shares(recent.map(row => row.accountName || 'none'))
  return {
    finished: recent.length,
    spanMs: starts.length ? now - Math.min(...starts) : null,
    latency: latencyStats(recent),
    mix,
    topModels: shares(recent.map(row => row.effectiveModel || row.requestedModel || 'unknown'), 3),
    strategies: shares(recent.map(row => row.selectedStrategy || 'none')),
    accounts: accountShares.length >= 2 ? accountShares : null,
  }
}
