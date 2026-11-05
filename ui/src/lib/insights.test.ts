import type { Issue, IssueInputs } from './insights.ts'
import type { Sample } from './samples.ts'
import type { Faults, Scope } from './store.svelte.ts'
import { describe, expect, it } from 'vitest'
import { account, accountsRouting, m365Ready, overview, quota, request } from '../test/fixtures.ts'
import { accountsAttention, deriveIssues, latencyStats, percentile, ringInsights, shares, summarySentence } from './insights.ts'
import { pushSample, sampleFrom } from './samples.ts'

const NOW = Date.parse('2026-11-05T14:10:00Z')

function inputs(overrides: Partial<IssueInputs> = {}): IssueInputs {
  return {
    now: NOW,
    href: 'http://work.localhost:4141/dashboard#/overview',
    overview: overview(),
    overviewAt: new Date(NOW),
    samples: [],
    faults: {},
    connection: { state: 'connected', blockedStatus: 0, blockedMessage: '' },
    accountsMode: 'routing',
    accounts: null,
    accountsAt: null,
    m365: null,
    m365At: null,
    restartedAt: null,
    dismissed: [],
    ...overrides,
  }
}

const ids = (issues: Issue[]) => issues.map(issue => issue.id)
const issue = (input: IssueInputs, id: string) => deriveIssues(input).find(item => item.id === id)

function fault(scope: Scope, message = 'boom'): Faults {
  const at = new Date(NOW - 60_000)
  return { [scope]: { scope, message, since: at, count: 3 } }
}

/** Samples every 2 s ending at `end`, with counters from `pick(index)`. */
function samples(count: number, end: number, pick: (index: number) => Partial<Sample>): Sample[] {
  let list: Sample[] = []
  for (let index = 0; index < count; index++)
    list = pushSample(list, { ...sampleFrom(overview(), end - (count - 1 - index) * 2000), ...pick(index) })
  return list
}

describe('deriveIssues: a healthy proxy is quiet', () => {
  it('has no issues', () => {
    expect(deriveIssues(inputs())).toEqual([])
  })
})

describe('connection rules', () => {
  it('c1 lost → Retry now with no body (the connection strip carries the cadence); clears on success', () => {
    const lost = issue(inputs({ connection: { state: 'lost', blockedStatus: 0, blockedMessage: '' } }), 'C1')
    expect(lost).toMatchObject({ tone: 'bad', title: 'Can\'t reach ghc-proxy', actions: [{ kind: 'retry', scope: 'overview' }] })
    expect(lost?.body).toBeUndefined()
    expect(issue(inputs(), 'C1')).toBeUndefined()
  })

  it('c2 blocked: 421 links to localhost on the same port', () => {
    const blocked = issue(inputs({ connection: { state: 'blocked', blockedStatus: 421, blockedMessage: 'No account is configured for hostname "x".' } }), 'C2')
    expect(blocked).toMatchObject({ title: 'Access denied', body: 'No account is configured for hostname "x".' })
    expect(blocked?.actions[0]).toMatchObject({ label: 'Open on localhost', href: 'http://localhost:4141/dashboard#/overview' })
    expect(issue(inputs({ connection: { state: 'blocked', blockedStatus: 403, blockedMessage: 'denied' } }), 'C2')?.actions).toEqual([])
  })
})

describe('fault rules', () => {
  it('f1 per data scope with since/count and Retry', () => {
    const models = issue(inputs({ faults: fault('models') }), 'F1:models')
    expect(models).toMatchObject({ tone: 'warn', title: 'Couldn\'t load Models', body: 'boom', count: 3, actions: [{ kind: 'retry', scope: 'models' }] })
    expect(issue(inputs(), 'F1:models')).toBeUndefined()
  })

  it('f2 metadata offers Retry refresh and Dismiss', () => {
    const metadata = issue(inputs({ faults: fault('metadata', 'Metadata refresh incomplete.') }), 'F2')
    expect(metadata?.actions.map(action => action.kind)).toEqual(['refresh', 'dismiss'])
  })
})

describe('health rules', () => {
  const auth = overview().auth

  it('h1 GitHub missing: Open Accounts with routing, CLI hint otherwise; not for M365', () => {
    const missing = overview({ auth: { ...auth, github: { ...auth.github, status: 'missing' } } })
    expect(issue(inputs({ overview: missing }), 'H1')).toMatchObject({ tone: 'bad', title: 'GitHub isn\'t signed in for work', actions: [{ label: 'Open Accounts' }] })
    expect(issue(inputs({ overview: missing, accountsMode: 'legacy' }), 'H1')?.body).toContain('Run "ghc-proxy auth" in a terminal.')
    const m365 = overview({ auth: { ...auth, upstream: 'm365', github: { ...auth.github, status: 'missing' } } })
    expect(issue(inputs({ overview: m365 }), 'H1')).toBeUndefined()
  })

  it('h2 Copilot missing', () => {
    const missing = overview({ auth: { ...auth, copilot: { ...auth.copilot, status: 'missing' } } })
    expect(issue(inputs({ overview: missing }), 'H2')?.title).toBe('Copilot isn\'t connected for work')
  })

  it('h3 degraded explains GitHub causes or the M365 availability cause', () => {
    const github = overview({ auth: { ...auth, copilot: { status: 'degraded', modelsLoaded: false, lastRefreshSucceeded: false } } })
    expect(issue(inputs({ overview: github }), 'H3')).toMatchObject({ body: 'Models couldn\'t be loaded. The last token refresh failed.', actions: [{ kind: 'refresh' }] })
    const m365 = overview({ auth: { ...auth, upstream: 'm365', copilot: { status: 'degraded', modelsLoaded: true } } })
    const m365At = new Date(NOW - 5000)
    const withCause = issue(inputs({ overview: m365, m365: m365Ready({ availability: { status: 'unavailable', cause: 'helper exited', updatedAt: 1 } }), m365At }), 'H3')
    expect(withCause).toMatchObject({ body: 'Microsoft 365 target is unavailable: helper exited', asOf: m365At, actions: [{ href: '#/accounts?section=m365' }] })
    expect(issue(inputs({ overview: m365 }), 'H3')?.body).toBe('Copilot reported a degraded state.')
    expect(issue(inputs(), 'H3')).toBeUndefined()
  })

  it('q1 used up, Q2 running low, Q3 unavailable, Q4 stale', () => {
    const premium = (remaining: number, percentRemaining: number) => ({ entitlement: 100, remaining, percentRemaining, unlimited: false, overagePermitted: false })
    const usedUp = overview({ quota: quota({ premiumInteractions: premium(0, 0) }) })
    expect(issue(inputs({ overview: usedUp }), 'Q1')).toMatchObject({ tone: 'bad', body: 'Resets 2026-12-01.' })
    expect(issue(inputs({ overview: usedUp }), 'Q2')).toBeUndefined()
    const low = overview({ quota: quota({ premiumInteractions: premium(12, 12) }) })
    expect(issue(inputs({ overview: low }), 'Q2')?.body).toBe('12.0 % left · resets 2026-12-01')
    expect(issue(inputs({ overview: overview({ quota: quota({ premiumInteractions: premium(21, 21) }) }) }), 'Q2')).toBeUndefined()
    // Nearly used up (bad meter tone) is still Q2, and so is 0 left with overage permitted.
    const nearlyOut = inputs({ overview: overview({ quota: quota({ premiumInteractions: premium(3, 3) }) }) })
    expect(issue(nearlyOut, 'Q2')).toMatchObject({ tone: 'warn', body: '3.0 % left · resets 2026-12-01' })
    expect(summarySentence(deriveIssues(nearlyOut), nearlyOut).tone).toBe('warn')
    const overage = overview({ quota: quota({ premiumInteractions: { ...premium(0, 0), overagePermitted: true } }) })
    expect(issue(inputs({ overview: overage }), 'Q1')).toBeUndefined()
    expect(issue(inputs({ overview: overage }), 'Q2')?.body).toBe('0.0 % left · resets 2026-12-01')
    expect(issue(inputs({ overview: overview({ quota: { status: 'unavailable' } }) }), 'Q3')?.title).toBe('Quota couldn\'t be loaded')
    const m365 = overview({ auth: { ...auth, upstream: 'm365' }, quota: { status: 'unavailable' } })
    expect(issue(inputs({ overview: m365 }), 'Q3')).toBeUndefined()
    expect(issue(inputs({ overview: overview({ quota: quota({ status: 'stale' }) }) }), 'Q4')?.tone).toBe('info')
  })
})

describe('activity rules', () => {
  it('r1 failure spike triggers, and decays once failures age out of the 5-min window', () => {
    // 10 failures in 20 completed over the last minute.
    const spike = samples(31, NOW, index => ({ completed: index < 1 ? 0 : 20, failed: index < 1 ? 0 : 10 }))
    expect(issue(inputs({ samples: spike }), 'R1')).toMatchObject({ title: '10 of 20 requests in the last 5 min failed', actions: [{ href: '#/requests?state=failed' }] })
    // Same samples, 6 minutes later: the deltas fall out of the window.
    expect(issue(inputs({ samples: spike, now: NOW + 360_000 }), 'R1')).toBeUndefined()
    // Ratio below 0.2 clears it.
    const healthy = samples(31, NOW, index => ({ completed: index < 1 ? 0 : 100, failed: index < 1 ? 0 : 10 }))
    expect(issue(inputs({ samples: healthy }), 'R1')).toBeUndefined()
  })

  it('r2 queueing needs pending > 0 in the last 3 contiguous samples', () => {
    const queued = overview({ queue: { pending: 2 } })
    expect(issue(inputs({ overview: queued, samples: samples(3, NOW, () => ({ qPending: 2 })) }), 'R2')?.body).toBe('2 waiting for 4 upstream slots.')
    expect(issue(inputs({ overview: queued, samples: samples(3, NOW, index => ({ qPending: index === 2 ? 0 : 2 })) }), 'R2')).toBeUndefined()
  })

  it('r3 queue full, R4 account cooldown, R5 model cooldowns', () => {
    expect(issue(inputs({ overview: overview({ queue: { pending: 64 } }) }), 'R3')?.body).toBe('64 of 64 waiting.')
    expect(issue(inputs({ overview: overview({ queue: { pending: 63 } }) }), 'R3')).toBeUndefined()
    expect(issue(inputs({ overview: overview({ queue: { accountCooldown: true } }) }), 'R4')?.tone).toBe('warn')
    expect(issue(inputs({ overview: overview({ queue: { modelCooldowns: 2 } }) }), 'R5')?.title).toBe('2 model cooldowns active')
  })
})

describe('account and restart rules', () => {
  it('a1 lists other accounts needing attention as of the last accounts load', () => {
    const accountsAt = new Date(NOW - 30_000)
    const accounts = accountsRouting({
      accounts: [
        account({ name: 'work' }),
        account({ name: 'personal', copilot: { status: 'missing', modelsLoaded: false } }),
        account({ name: 'a', quota: { status: 'unavailable' } }),
        account({ name: 'b', copilot: { status: 'degraded', modelsLoaded: true } }),
        account({ name: 'c', github: { status: 'missing', accountType: 'individual' } }),
      ],
    })
    const others = issue(inputs({ accounts, accountsAt }), 'A1')
    expect(others).toMatchObject({ title: '4 other accounts need attention', body: 'personal, a, b +1', asOf: accountsAt })
    expect(issue(inputs({ accounts: accountsRouting() }), 'A1')).toBeUndefined()
    // Stale quota is routine: it warns the nav lamp but never raises A1.
    const stale = accountsRouting({ accounts: [account({ name: 'work' }), account({ name: 'personal', quota: { status: 'stale' } })] })
    expect(issue(inputs({ accounts: stale }), 'A1')).toBeUndefined()
    expect(accountsAttention(stale, null)).toBe('warn')
    expect(accountsAttention(accounts, null)).toBe('bad')
    expect(accountsAttention(accountsRouting(), null)).toBeNull()
  })

  it('p1 restart notice clears after Dismiss or 5 minutes', () => {
    const restartedAt = new Date(NOW - 60_000)
    const restart = deriveIssues(inputs({ restartedAt }))[0]!
    expect(restart).toMatchObject({ tone: 'info', body: 'Live charts started over.' })
    expect(deriveIssues(inputs({ restartedAt, dismissed: [restart.id] }))).toEqual([])
    expect(deriveIssues(inputs({ restartedAt, now: NOW + 300_000 }))).toEqual([])
  })

  it('orders connection, then bad, warn and info', () => {
    const order = ids(deriveIssues(inputs({
      connection: { state: 'lost', blockedStatus: 0, blockedMessage: '' },
      faults: fault('requests'),
      overview: overview({ queue: { pending: 64, modelCooldowns: 1 } }),
      restartedAt: new Date(NOW),
    })))
    expect(order[0]).toBe('C1')
    expect(order.slice(1, 3)).toEqual(['R3', 'F1:requests'])
    expect(order.slice(-2)).toEqual(['R5', `P1:${NOW}`])
  })
})

describe('summarySentence (spec §6.2)', () => {
  const base = { overview: overview(), overviewAt: new Date(2026, 10, 5, 14, 2, 11), connection: inputs().connection }

  it('covers loading, lost, blocked, issues and the all-normal sentences', () => {
    expect(summarySentence([], { ...base, overview: null }).text).toBe('Connecting to ghc-proxy…')
    expect(summarySentence([], { ...base, connection: { state: 'lost', blockedStatus: 0, blockedMessage: '' } }).text).toBe('Can\'t reach ghc-proxy. Showing data from 14:02:11.')
    expect(summarySentence([], { ...base, connection: { state: 'blocked', blockedStatus: 403, blockedMessage: '' } }).text).toBe('This page can\'t read the proxy.')
    const issues = deriveIssues(inputs({ overview: overview({ queue: { pending: 64, accountCooldown: true } }) }))
    expect(summarySentence(issues, base)).toEqual({ tone: 'bad', text: 'The upstream queue is full · 1 more' })
    expect(summarySentence([], base)).toEqual({ tone: 'ok', text: 'All normal. 81.2 % of premium requests left.' })
    const unlimited = { entitlement: 0, remaining: 0, percentRemaining: 100, unlimited: true, overagePermitted: false }
    expect(summarySentence([], { ...base, overview: overview({ quota: quota({ premiumInteractions: unlimited }) }) }).text).toBe('All normal. Premium requests are unlimited.')
    expect(summarySentence([], { ...base, overview: overview({ quota: { status: 'unavailable' } }) }).text).toBe('All normal.')
    const auth = overview().auth
    expect(summarySentence([], { ...base, overview: overview({ auth: { ...auth, upstream: 'm365', identity: 'user@corp.com' }, quota: { status: 'not_applicable' } }) }).text)
      .toBe('All normal.')
  })
})

describe('ring insights (spec §6.4)', () => {
  it('uses nearest-rank percentiles and needs 5 completed rows', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    expect(latencyStats([request('a'), request('b')])).toBeNull()
  })

  it('folds shares beyond the top into "k others" without exceeding 100 %', () => {
    const result = shares(['a', 'a', 'b', 'c', 'd', 'e'], 3)
    expect(result.map(share => share.label)).toEqual(['a', 'b', 'c', '2 others'])
    expect(shares(['a', 'b', 'c', 'd'], 3).at(-1)?.label).toBe('1 other')
    expect(result.reduce((sum, share) => sum + share.pct, 0)).toBeLessThanOrEqual(100)
  })

  it('computes the status mix, span and account shares', () => {
    const recent = [
      request('1', { durationMs: 100, accountName: 'work' }),
      request('2', { durationMs: 200, accountName: 'work' }),
      request('3', { durationMs: 300, accountName: 'personal' }),
      request('4', { durationMs: 400 }),
      request('5', { durationMs: 500 }),
      request('6', { state: 'failed', status: 404 }),
      request('7', { state: 'failed', status: undefined }),
    ]
    const active = [request('8', { state: 'aborted', status: undefined }), request('9', { state: 'streaming' })]
    const insights = ringInsights(recent, active, Date.parse('2026-11-05T14:02:51.000Z'))
    expect(insights.mix).toMatchObject({ ok: 5, client: 1, server: 1, aborted: 1 })
    expect(insights.mix.errorRate).toBeCloseTo(25)
    expect(insights.latency).toEqual({ n: 5, p50: 300, p95: 500, max: 500 })
    expect(insights.spanMs).toBe(60_000)
    expect(insights.accounts?.[0]).toMatchObject({ label: 'none', count: 4 })
  })
})
