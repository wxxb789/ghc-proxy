import type { OverviewResponse } from '@contract'
import type { Sample } from '../lib/samples.ts'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { health } from '../lib/health.svelte.ts'
import { loadAllViews } from '../lib/poller.svelte.ts'
import { startRouter } from '../lib/router.svelte.ts'
import { app, raiseFault, samples } from '../lib/store.svelte.ts'
import { createFakeFetch } from '../test/fake-fetch.ts'
import { clearFaults, dashboardRoutes, overview, quota } from '../test/fixtures.ts'
import Overview from './Overview.svelte'

const NOT_APPLICABLE = 'Not applicable: Microsoft 365 does not expose GitHub quota'

beforeEach(() => {
  history.replaceState(null, '', '/dashboard#/overview')
  app.data.overview = null
  app.data.accounts = null
  app.data.m365 = null
  app.loadedAt.overview = null
  app.loadedAt.accounts = null
  app.accountsMode = 'unknown'
  app.restartedAt = null
  app.live = true
  Object.assign(app.connection, { state: 'connecting', failures: 0, lostSince: null, blockedMessage: '', blockedStatus: 0 })
  samples.list = []
  samples.first = null
  clearFaults()
})

function show(data: OverviewResponse) {
  app.data.overview = data
  app.loadedAt.overview = new Date('2026-11-05T14:02:11')
  app.connection.state = 'connected'
  return render(Overview)
}

const tile = (label: string) => screen.getByText(label, { selector: '.placard' }).closest<HTMLElement>('.tile')!
const readout = (label: string) => tile(label).querySelector('.readout')!.textContent
const row = (table: string, service: string) => within(screen.getByRole('region', { name: table })).getByRole('cell', { name: service }).closest('tr')!

function sample(t: number, values: Partial<Sample> = {}): Sample {
  return { t, gap: false, active: 0, qActive: 0, qPending: 0, qConcurrency: 4, maxPending: 64, started: 0, completed: 0, failed: 0, aborted: 0, uptimeMs: t, startedAt: 'x', ...values }
}

describe('overview legacy pins (T:145-176)', () => {
  it('shows activity.aborted in the Aborted tile and the exact Accounts line', async () => {
    const fake = createFakeFetch(dashboardRoutes({ '/dashboard/api/overview': () => overview({ activity: { aborted: 7, completed: 1284, failed: 12 } }) }))
    vi.stubGlobal('fetch', fake.fetch)
    render(Overview)
    await loadAllViews()
    await waitFor(() => expect(readout('Aborted')).toBe('7'))
    expect(readout('Completed')).toBe('1,284')
    const accounts = row('Authentication', 'Accounts')
    expect(within(accounts).getByRole('cell', { name: '2 total / default personal / current work' })).toHaveClass('mono')
    expect(within(accounts).getByText('ok')).toBeInTheDocument()
  })
})

describe('overview header and summary', () => {
  it('shows connecting state, readout placeholders and skeletons before data', () => {
    render(Overview)
    expect(screen.getByText('Connecting to ghc-proxy…')).toBeInTheDocument()
    expect(readout('Aborted')).toBe('—')
    expect(screen.getByRole('region', { name: 'Quota' }).querySelector('[aria-busy=true] .skel')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Issues' })).not.toBeInTheDocument()
  })

  it('reads all normal with the premium percent, plus the header meta and the multi-account note', () => {
    show(overview())
    expect(screen.getByText('All normal. 81.2 % of premium requests left.')).toBeInTheDocument()
    expect(screen.getByText(/GitHub upstream · up 3h 12m/)).toBeInTheDocument()
    expect(screen.getByText('Overview, quota and models reflect "work". Requests and Behavior cover every account.')).toBeInTheDocument()
  })

  it('reads unlimited premium and hides the note for one account', () => {
    show(overview({
      auth: { github: { status: 'ok', accountType: 'business' }, accounts: { currentAccount: 'work', defaultAccount: 'work', totalAccounts: 1 } },
      quota: quota({ premiumInteractions: { entitlement: 0, remaining: 0, percentRemaining: 100, unlimited: true, overagePermitted: false } }),
    }))
    expect(screen.getByText('All normal. Premium requests are unlimited.')).toBeInTheDocument()
    expect(screen.queryByText(/Requests and Behavior cover every account/)).not.toBeInTheDocument()
  })

  it('reads the worst issue title with the count of the others', () => {
    show(overview({ auth: { copilot: { status: 'missing', modelsLoaded: false } }, queue: { accountCooldown: true } }))
    expect(screen.getByText('Copilot isn\'t connected for work · 1 more')).toBeInTheDocument()
  })

  it('reads the lost-connection sentence with the last data time', () => {
    show(overview())
    app.connection.state = 'lost'
    return waitFor(() => expect(screen.getByText(/^Can't reach ghc-proxy\. Showing data from \d\d:\d\d:\d\d\.$/)).toBeInTheDocument())
  })
})

describe('overview issues panel', () => {
  it('is absent when healthy and when only info issues exist', () => {
    const view = show(overview())
    expect(health.issues).toEqual([])
    expect(screen.queryByRole('region', { name: 'Issues' })).not.toBeInTheDocument()
    view.unmount()
    show(overview({ quota: quota({ status: 'stale' }) }))
    expect(health.issues.map(issue => [issue.title, issue.tone])).toEqual([['Quota may be out of date', 'info']])
    expect(screen.queryByRole('region', { name: 'Issues' })).not.toBeInTheDocument()
  })

  it('lists every issue with the count when a warn issue exists', () => {
    show(overview({ auth: { copilot: { status: 'degraded', modelsLoaded: false } }, quota: quota({ status: 'stale' }) }))
    const panel = screen.getByRole('region', { name: 'Issues' })
    expect(within(panel).getByText('Copilot is degraded')).toBeInTheDocument()
    expect(within(panel).getByText('Quota may be out of date')).toBeInTheDocument()
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2)
    expect(panel.querySelector('.panel-meta')).toHaveTextContent('2')
  })
})

describe('overview cluster', () => {
  it('links the Active and Failed tiles to the filtered Requests view', () => {
    show(overview({ activity: { activeRequests: 2, failed: 12 } }))
    expect(screen.getByRole('link', { name: 'Active requests: 2. Show active requests' })).toHaveAttribute('href', '#/requests?state=active')
    expect(screen.getByRole('link', { name: 'Failed requests: 12. Show failed requests' })).toHaveAttribute('href', '#/requests?state=failed')
    expect(screen.getByRole('group', { name: 'Runtime summary' })).toBeInTheDocument()
  })

  it('derives sub-lines and strip figures from the sample buffer', () => {
    const list = Array.from({ length: 31 }, (_, index) => sample(index * 2000, { active: index % 3, completed: index, failed: index >= 28 ? index - 27 : 0 }))
    samples.list = list
    samples.first = list[0]!
    show(overview({ activity: { activeRequests: 1, completed: 30, failed: 3, aborted: 0 }, queue: { active: 1, pending: 0 } }))
    expect(tile('Active')).toHaveTextContent('peak 2 · 1 min')
    expect(tile('Completed')).toHaveTextContent('incl. 3 failed')
    expect(tile('Failed')).toHaveTextContent('+3 since open')
    expect(tile('Failed').querySelector('.readout')).toHaveClass('fg-bad')
    expect(tile('Aborted').querySelector('.readout')).not.toHaveClass('fg-warn')
    expect(readout('Queue')).toBe('1 / 0')
    expect(tile('Queue')).toHaveTextContent('4 slots · max 64')
    expect(screen.getByText('Throughput').parentElement).toHaveTextContent('Throughput 30 /min')
    expect(screen.getByText('Failure rate').parentElement).toHaveTextContent('10.0 %')
    expect(screen.getByText('since page open · 1 min')).toBeInTheDocument()
  })

  it('shows collecting… before enough samples and Live is paused while off', () => {
    app.live = false
    show(overview())
    expect(tile('Active')).toHaveTextContent('collecting…')
    expect(screen.getByText('Throughput').parentElement).toHaveTextContent('collecting…')
    expect(screen.getByText('Live is paused')).toBeInTheDocument()
  })

  it('keeps last-known values under an overview fault with a strip and stale tags on every overview region', async () => {
    show(overview({ activity: { aborted: 4 } }))
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    raiseFault('overview', new Error('Dashboard request failed: 500'))
    await waitFor(() => expect(screen.getByText(/Couldn't load Overview: Dashboard request failed: 500/)).toBeInTheDocument())
    expect(readout('Aborted')).toBe('4')
    expect(document.querySelectorAll('.fault-strip')).toHaveLength(1)
    expect(within(screen.getByRole('group', { name: 'Runtime summary' }).parentElement!).getByText('stale')).toHaveClass('tag-loud')
    for (const name of ['Quota', 'Authentication', 'Runtime'])
      expect(within(screen.getByRole('region', { name }).querySelector<HTMLElement>('.panel-meta')!).getByText('stale')).toHaveClass('tag-loud')
  })

  it('reads the sparkline window in whole minutes only, never "last 0 min"', () => {
    const short = [sample(0, { active: 1 }), sample(2000, { active: 2 })]
    samples.list = short
    samples.first = short[0]!
    const view = show(overview())
    expect(tile('Active')).toHaveTextContent('peak 2 · <1 min')
    expect(document.body.textContent).not.toMatch(/last \d+ min/)
    expect(within(tile('Active')).getByText('Active, last minute: low 1, high 2, now 2.')).toHaveClass('sr-only')
    view.unmount()
    const long = Array.from({ length: 31 }, (_, index) => sample(index * 2000, { qActive: index % 2, qPending: 0 }))
    samples.list = long
    samples.first = long[0]!
    show(overview())
    expect(within(tile('Queue')).getByText('Queue, last 1 min: low 0, high 1, now 0.')).toHaveClass('sr-only')
  })
})

describe('overview quota', () => {
  it('renders pools, unlimited pools and the meta line', () => {
    show(overview())
    const panel = screen.getByRole('region', { name: 'Quota' })
    expect(panel.querySelector('.panel-meta')).toHaveTextContent(/ok · resets 2026-12-01 · individual · fetched \d\d:\d\d:\d\d/)
    const premium = row('Quota', 'Premium')
    expect(premium).toHaveTextContent('812')
    expect(premium).toHaveTextContent('1,000')
    expect(premium).toHaveTextContent('81.2 %')
    expect(premium).toHaveTextContent('Allowed')
    expect(within(premium).getByRole('meter', { name: 'Premium remaining' })).toHaveAttribute('aria-valuenow', '81.2')
    const chat = row('Quota', 'Chat')
    expect(within(chat).getByText('Unlimited')).toBeInTheDocument()
    expect(within(chat).getAllByText('none')).toHaveLength(2)
    expect(within(chat).getByText('No')).toBeInTheDocument()
    expect(within(chat).queryByRole('meter')).not.toBeInTheDocument()
  })

  it('never renders NaN% for a missing percent and dashes a missing pool', () => {
    const premium = { entitlement: 300, remaining: 120, unlimited: false, overagePermitted: false } as unknown as NonNullable<OverviewResponse['quota']['premiumInteractions']>
    show(overview({ quota: quota({ premiumInteractions: premium, completions: undefined }) }))
    expect(document.body.textContent).not.toContain('NaN')
    expect(within(row('Quota', 'Premium')).getByText('none')).toBeInTheDocument()
    expect(within(row('Quota', 'Completions')).getAllByText('none')).toHaveLength(4)
  })

  it('notes stale values, and shows an empty state without data', async () => {
    const view = show(overview({ quota: quota({ status: 'stale' }) }))
    expect(screen.getByText('Showing last known values.')).toBeInTheDocument()
    view.unmount()
    show(overview({ quota: { status: 'unavailable' } }))
    expect(screen.getByText('No quota data yet.')).toBeInTheDocument()
  })
})

describe('overview on the M365 upstream', () => {
  it('shows the single Microsoft 365 auth row and quota as not applicable', () => {
    show(overview({
      auth: {
        upstream: 'm365',
        identity: 'user@corp.com',
        github: { status: 'not_applicable', accountType: 'individual' },
        copilot: { status: 'ok', modelsLoaded: true, lastRefreshAt: '2026-11-05T14:01:55.000Z' },
      },
      quota: { status: 'not_applicable' },
    }))
    const auth = screen.getByRole('region', { name: 'Authentication' })
    const services = within(auth).getAllByRole('row').slice(1).map(tr => tr.querySelector('td')!.textContent)
    expect(services).toEqual(['Microsoft 365', 'Accounts'])
    expect(within(row('Authentication', 'Microsoft 365')).getByText('user@corp.com')).toBeInTheDocument()
    const quotaPanel = screen.getByRole('region', { name: 'Quota' })
    expect(quotaPanel.querySelector('.panel-meta')).toHaveTextContent(NOT_APPLICABLE)
    expect(within(quotaPanel).getAllByText(NOT_APPLICABLE)).toHaveLength(2)
    expect(within(quotaPanel).queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('All normal.')).toBeInTheDocument()
    expect(screen.getByText(/Microsoft 365 upstream/)).toBeInTheDocument()
  })

  it('falls back to Broker account without an identity', () => {
    show(overview({ auth: { upstream: 'm365', github: { status: 'not_applicable', accountType: 'individual' } }, quota: { status: 'not_applicable' } }))
    expect(within(row('Authentication', 'Microsoft 365')).getByText('Broker account')).toBeInTheDocument()
  })
})

describe('overview authentication and runtime', () => {
  it('adds the Copilot token line and flags a failed refresh', () => {
    show(overview({ auth: { copilot: { status: 'ok', modelsLoaded: true, expiresAt: '2026-11-05T14:30:00.000Z', lastRefreshSucceeded: false } } }))
    const copilot = row('Authentication', 'Copilot')
    expect(copilot).toHaveTextContent(/models loaded\s*token expires \d\d:\d\d:\d\d/)
    expect(within(copilot).getByText('· last refresh failed')).toHaveClass('fg-warn')
    expect(row('Authentication', 'GitHub')).toHaveTextContent('octocat')
  })

  it('shows the runtime facts with formatted numbers', () => {
    show(overview({ activity: { started: 1299, recentRequests: 2120 }, queue: { active: 1, concurrency: 4, pending: 0, maxPending: 64, modelCooldowns: 2, accountCooldown: true } }))
    const runtime = screen.getByRole('region', { name: 'Runtime' })
    for (const [label, value] of [['Requests started', '1,299'], ['Recent finished', '2,120'], ['Upstream slots', '1 / 4'], ['Pending queue', '0 / 64'], ['Cooldowns', 'account + 2 models'], ['Version', '0.11.4']])
      expect(within(runtime).getByText(label).nextElementSibling).toHaveTextContent(value!)
  })
})

describe('overview section focus', () => {
  let stopRouter: () => void
  afterEach(() => stopRouter())

  it('focuses the Quota h2 for section=quota, from another view and from an issue action', async () => {
    history.replaceState(null, '', '/dashboard#/requests')
    stopRouter = startRouter(() => {})
    show(overview({ quota: quota({ premiumInteractions: { entitlement: 1000, remaining: 120, percentRemaining: 12, unlimited: false, overagePermitted: false } }) }))
    location.hash = '#/overview?section=quota'
    const heading = screen.getByRole('heading', { name: 'Quota' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading).toHaveAttribute('id', 'quota-h')
    await waitFor(() => expect(location.hash).toBe('#/overview'))

    heading.blur()
    const panel = screen.getByRole('region', { name: 'Issues' })
    await userEvent.setup().click(within(panel).getByRole('link', { name: 'View quota' }))
    await waitFor(() => expect(heading).toHaveFocus())
  })
})
