import type { M365ProbeResponse, MscAccount } from '@contract'
import type { FakeFetch, RouteHandler } from '../../test/fake-fetch.ts'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTarget } from '../../lib/account-actions.svelte.ts'
import { m365EndpointStatus, registerM365, saveM365Endpoint } from '../../lib/m365-actions.svelte.ts'
import { applyM365State } from '../../lib/m365-load.svelte.ts'
import { loadAllViews } from '../../lib/poller.svelte.ts'
import { app, faults } from '../../lib/store.svelte.ts'
import { createFakeFetch, jsonError } from '../../test/fake-fetch.ts'
import { clearFaults, dashboardRoutes, m365Absent, m365Ready } from '../../test/fixtures.ts'
import M365Panel from './M365Panel.svelte'

vi.mock('../../lib/account-actions.svelte.ts', () => ({ removeTarget: vi.fn() }))

const ENDPOINT_A = 'https://substrate.office.com/m365Copilot/api/v1/llmapi'
const ENDPOINT_B = 'https://df.loki.delve.office.com/api/v1/llmapi'
const CUSTOM = 'https://custom.example.test/api'
const broker: MscAccount = { upn: 'new@corp.com', homeAccountId: 'new-home-account-id-0001', environment: 'login.windows.net' }
const other: MscAccount = { upn: 'old@corp.com', homeAccountId: 'old-home-account-id-0002', environment: 'login.windows.net' }

function probeResult(accounts: MscAccount[] = [], overrides: Partial<M365ProbeResponse> = {}): M365ProbeResponse {
  return { schemaVersion: 1, generatedAt: '', platformSupported: true, helperAvailable: true, accountCount: accounts.length, accounts, ...overrides }
}

let fake: FakeFetch
const byId = (id: string) => document.getElementById(id)!
const posts = () => fake.log.filter(request => request.method !== 'GET').map(request => `${request.method} ${request.path}`)

function setup(routes: Record<string, RouteHandler> = {}) {
  fake = createFakeFetch(dashboardRoutes(routes))
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

/** Applies a state the way a load does, then renders the panel. */
function renderWith(state = m365Ready(), probe: M365ProbeResponse | null = null) {
  app.m365.probe = probe
  applyM365State(state)
  return render(M365Panel)
}

beforeEach(() => {
  history.replaceState(null, '', '/dashboard#/overview')
  clearFaults()
  Object.assign(app.busy, { m365Target: false, m365Probe: false, m365SignIn: false, m365Account: false, m365Hostname: false })
  app.accountsMode = 'routing'
  app.accountBusy = {}
  Object.assign(app.m365, {
    snapshotKey: '',
    view: null,
    probe: null,
    probeStarted: false,
    readiness: [],
    status: '',
    statusIsError: false,
    drafts: { endpoint: '', custom: '', hostname: '', registerHostname: '', registerAccount: '', account: '', signInUpn: '' },
    dirty: { endpoint: false, hostname: false },
  })
  Object.assign(m365EndpointStatus, { text: '', tone: '' })
  setup()
})

describe('registered target (T:452-497)', () => {
  it('shows Ready., the client environment and the summary without the hostname', () => {
    renderWith()
    // Resting "Ready." repeats the header tag: still announced, but visually hidden.
    expect(byId('m365-status').textContent).toBe('Ready.')
    expect(byId('m365-status')).toHaveClass('sr-only')
    expect(byId('m365-client').textContent).toBe('ANTHROPIC_BASE_URL=http://m365.localhost:4141\nANTHROPIC_AUTH_TOKEN=dummy-token\nANTHROPIC_MODEL=claude-opus-5.5')
    expect(byId('m365-client')).toHaveAccessibleName('Client environment')
    expect(screen.getByRole('button', { name: 'Copy Client environment' })).toBeInTheDocument()
    // Targets lists the same rows outside 409 mode.
    expect(document.getElementById('m365-routing')).toBeNull()
    expect(byId('m365-summary').textContent).toMatch(/^user@corp\.com · 2 models · token until \d\d:\d\d$/)
    expect(screen.getByRole('heading', { level: 2, name: 'M365 Copilot target' })).toHaveAttribute('id', 'm365-h')
    expect(byId('m365-panel')).toHaveTextContent('ready')
    expect(screen.getByRole('combobox', { name: 'Upstream endpoint' })).toHaveAttribute('id', 'm365-endpoint')
  })

  it('lists the routing rows only when Targets cannot (409)', () => {
    app.accountsMode = 'unavailable'
    renderWith()
    const items = Array.from(byId('m365-routing').querySelectorAll('li'), item => item.textContent)
    expect(items.some(text => text?.includes('m365 → m365.localhost'))).toBe(true)
  })

  it('shows the cause once, in the callout, when the target is unavailable', () => {
    renderWith(m365Ready({ availability: { status: 'unavailable', cause: 'Token expired', updatedAt: 1 } }))
    expect(byId('m365-status').textContent).toBe('Token expired')
    expect(byId('m365-status')).toHaveClass('sr-only')
    expect(byId('m365-summary')).not.toHaveTextContent('Token expired')
    expect(byId('m365-active').querySelector('.callout')).toHaveTextContent('Token expired')
  })

  it('removes through the shared flow, and explains when it cannot', async () => {
    const user = userEvent.setup()
    renderWith()
    // Refresh sits with the broker select; Remove sits in its own footer after the setup flow.
    expect(byId('m365-form')).toContainElement(screen.getByRole('button', { name: 'Refresh broker accounts' }))
    const remove = screen.getByRole('button', { name: 'Remove M365 target' })
    expect(byId('m365-active')).not.toContainElement(remove)
    expect(remove.closest('.danger-zone')).not.toBeNull()
    await user.click(remove)
    expect(removeTarget).toHaveBeenCalledWith({ name: 'm365', hostname: 'm365.localhost' })
  })

  it.each([
    [[{ target: 'm365', hostname: 'm365.localhost', kind: 'm365' as const, isDefault: true }], 'The M365 target is the only target and cannot be removed.'],
    [[{ target: 'personal', hostname: 'personal.localhost', kind: 'github' as const, isDefault: false }, { target: 'm365', hostname: 'm365.localhost', kind: 'm365' as const, isDefault: true }], 'Choose another default target before removing the M365 target.'],
  ])('keeps Remove M365 target aria-disabled with a visible reason', async (routing, reason) => {
    const user = userEvent.setup()
    renderWith(m365Ready({ routing }))
    const button = screen.getByRole('button', { name: 'Remove M365 target' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(reason)
    expect(screen.getByText(reason)).toBeVisible()
    await user.click(button)
    expect(removeTarget).not.toHaveBeenCalled()
  })

  it('keeps a failed hostname save dirty, and reseeds only after success (quirk 8)', async () => {
    const user = userEvent.setup()
    let fail = true
    setup({ 'POST /dashboard/api/m365/hostname': () => fail ? jsonError(400, 'Invalid hostname') : m365Ready({ hostname: 'copilot.localhost' }) })
    renderWith()
    const input = byId('m365-hostname') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Copilot.localhost')
    await user.click(screen.getByRole('button', { name: 'Save hostname' }))
    await waitFor(() => expect(byId('m365-status').textContent).toBe('Invalid hostname'))
    expect(byId('m365-status')).toHaveClass('is-error')
    expect(byId('m365-status')).not.toHaveClass('sr-only')
    expect(app.m365.dirty.hostname).toBe(true)
    applyM365State(m365Ready({ modelCount: 3 }))
    await waitFor(() => expect(byId('m365-summary').textContent).toContain('3 models'))
    expect(input.value).toBe('Copilot.localhost')

    fail = false
    await user.click(screen.getByRole('button', { name: 'Save hostname' }))
    await waitFor(() => expect(byId('m365-status').textContent).toBe('Saved.'))
    expect(byId('m365-status')).not.toHaveClass('sr-only')
    expect(fake.log.find(request => request.path === '/dashboard/api/m365/hostname')?.body).toEqual({ hostname: 'Copilot.localhost' })
    expect(app.m365.dirty.hostname).toBe(false)
    expect(input.value).toBe('copilot.localhost')
    expect(faults).toEqual({})
  })

  it('applies the selected broker account', async () => {
    const user = userEvent.setup()
    setup({ 'POST /dashboard/api/m365/account': () => m365Ready() })
    renderWith(m365Ready(), probeResult([broker]))
    const select = byId('m365-account') as HTMLSelectElement
    // The registered account is prepended because the probe does not list it.
    expect(Array.from(select.options, option => option.value)).toEqual(['home-account-id-1234567890', broker.homeAccountId])
    expect(select.value).toBe('home-account-id-1234567890')
    await user.selectOptions(select, broker.homeAccountId)
    await user.click(screen.getByRole('button', { name: 'Use this account' }))
    await waitFor(() => expect(byId('m365-status').textContent).toBe('Saved.'))
    expect(fake.log.find(request => request.path === '/dashboard/api/m365/account')?.body).toEqual({ account: broker.homeAccountId })
  })
})

describe('upstream endpoint', () => {
  it.each([
    ['endpoint', 'm365-endpoint-save', () => saveM365Endpoint(false), () => registerM365()],
    ['endpoint', 'm365-custom-endpoint-save', () => saveM365Endpoint(true), () => registerM365()],
    ['register', 'm365-register', () => registerM365(), () => saveM365Endpoint(false)],
  ] as const)('prevents competing mutations while %s (#%s) is pending, busy only on that button (T:499-535)', async (path, busyId, start, compete) => {
    const state = m365Absent({ endpoint: ENDPOINT_B, endpoints: [ENDPOINT_B] })
    setup({
      'POST /dashboard/api/m365/endpoint': () => state,
      'POST /dashboard/api/m365/register': () => state,
      '/dashboard/api/m365': () => state,
    })
    renderWith(state, probeResult([broker]))
    app.m365.drafts.custom = CUSTOM
    const hold = fake.hold(`POST /dashboard/api/m365/${path}`)
    const pending = start()
    await compete()
    await waitFor(() => expect(byId('m365-register')).toBeDisabled())
    expect(posts()).toEqual([`POST /dashboard/api/m365/${path}`])
    for (const id of ['m365-endpoint', 'm365-endpoint-save', 'm365-custom-endpoint', 'm365-custom-endpoint-save'])
      expect(byId(id)).toBeDisabled()
    for (const id of ['m365-endpoint-save', 'm365-custom-endpoint-save', 'm365-register'])
      expect(byId(id).getAttribute('aria-busy'), id).toBe(id === busyId ? 'true' : null)
    hold.release()
    await pending
    await waitFor(() => expect(byId('m365-endpoint')).toBeEnabled())
    expect(byId('m365-register')).toBeEnabled()
    expect(byId(busyId)).not.toHaveAttribute('aria-busy')
    expect(posts()).toHaveLength(1)
  })

  it('keeps a dirty selection across re-renders and adds a custom endpoint', async () => {
    const user = userEvent.setup()
    const saved = m365Ready({ endpoint: CUSTOM, endpoints: [ENDPOINT_A, ENDPOINT_B, CUSTOM] })
    setup({ 'POST /dashboard/api/m365/endpoint': () => saved, '/dashboard/api/m365': () => saved })
    renderWith(m365Ready({ endpoints: [ENDPOINT_A, ENDPOINT_B] }))
    const select = byId('m365-endpoint') as HTMLSelectElement
    expect(select).toHaveAccessibleDescription(/Your Microsoft access token is sent to the selected upstream endpoint/)
    expect(byId('m365-custom-endpoint')).toHaveAttribute('aria-describedby', 'm365-endpoint-warning')
    await user.selectOptions(select, ENDPOINT_B)
    expect(app.m365.dirty.endpoint).toBe(true)

    // A poll with a changed snapshot re-renders without overwriting the dirty choice.
    expect(applyM365State(m365Ready({ endpoints: [ENDPOINT_A], modelCount: 5 }))).toBe(true)
    await waitFor(() => expect(byId('m365-summary').textContent).toContain('5 models'))
    expect(select.value).toBe(ENDPOINT_B)
    expect(Array.from(select.options, option => option.value)).toEqual([ENDPOINT_A, ENDPOINT_B])
    expect(select).toHaveAttribute('title', ENDPOINT_B)

    await user.type(byId('m365-custom-endpoint'), CUSTOM)
    await user.click(screen.getByRole('button', { name: 'Add and use endpoint' }))
    await waitFor(() => expect(byId('m365-endpoint-status').textContent).toBe(`Saved upstream endpoint: ${CUSTOM}`))
    const request = fake.log.find(entry => entry.path === '/dashboard/api/m365/endpoint')!
    expect(request.contentType).toBe('application/json')
    expect(request.body).toEqual({ endpoint: CUSTOM, endpoints: [ENDPOINT_A, ENDPOINT_B, CUSTOM] })
    expect(byId('m365-custom-endpoint')).toHaveValue('')
    expect(app.m365.dirty.endpoint).toBe(false)
    expect(select.value).toBe(CUSTOM)
    expect(byId('m365-status').textContent).toBe('Saved.')
  })

  it('copies a save error into the endpoint status', async () => {
    const user = userEvent.setup()
    setup({ 'POST /dashboard/api/m365/endpoint': () => jsonError(400, 'Invalid M365 endpoint payload.') })
    renderWith(m365Absent())
    await user.click(screen.getByRole('button', { name: 'Use endpoint' }))
    await waitFor(() => expect(byId('m365-endpoint-status').textContent).toBe('Invalid M365 endpoint payload.'))
    expect(fake.log.find(entry => entry.path === '/dashboard/api/m365/endpoint')?.body).toEqual({ endpoint: ENDPOINT_A })
    expect(byId('m365-status').textContent).toBe('Invalid M365 endpoint payload.')
    expect(faults).toEqual({})
  })
})

describe('not added', () => {
  it('registers the chosen broker account with the hostname and endpoint drafts', async () => {
    const user = userEvent.setup()
    setup({ 'POST /dashboard/api/m365/register': () => m365Ready() })
    renderWith(m365Absent(), probeResult([other, broker]))
    expect(byId('m365-status').textContent).toBe('Not added.')
    expect(byId('m365-status')).toHaveClass('sr-only')
    expect(byId('m365-absent')).toHaveTextContent('If your work account isn\'t listed, sign in with Microsoft.')
    const help = 'Only Windows broker accounts are listed. Choose a work account with an M365 Copilot subscription.'
    expect(screen.getByRole('textbox', { name: 'Account email (optional)' })).toHaveAccessibleDescription(help)
    expect(screen.getByRole('button', { name: 'Sign in another M365 account' })).toHaveAccessibleDescription(help)
    expect(byId('m365-register-hostname')).toHaveValue('m365.localhost')
    const select = byId('m365-register-account') as HTMLSelectElement
    expect(select.options[1]!.textContent).toBe('new@corp.com — new-home-acc… (login.windows.net)')
    expect(select.options[1]).toHaveAttribute('title', broker.homeAccountId)
    await user.selectOptions(select, broker.homeAccountId)
    await user.click(screen.getByRole('button', { name: 'Add M365 target' }))
    await waitFor(() => expect(byId('m365-status').textContent).toBe('Saved.'))
    expect(fake.log.find(entry => entry.path === '/dashboard/api/m365/register')?.body)
      .toEqual({ account: broker.homeAccountId, hostname: 'm365.localhost', endpoint: ENDPOINT_A })
  })

  it('hides the register form until a probe lists broker accounts', () => {
    renderWith(m365Absent(), probeResult([]))
    expect(document.getElementById('m365-register-form')).toBeNull()
  })

  it('signs in, probes again and preselects the new account without applying it', async () => {
    const user = userEvent.setup()
    setup({
      'POST /dashboard/api/m365/sign-in': () => ({ schemaVersion: 1, generatedAt: '', account: broker }),
      'POST /dashboard/api/m365/probe': () => probeResult([other, broker]),
    })
    renderWith(m365Absent(), probeResult([other]))
    await user.type(screen.getByRole('textbox', { name: 'Account email (optional)' }), 'new@corp.com')
    await user.click(screen.getByRole('button', { name: 'Sign in another M365 account' }))
    await waitFor(() => expect(byId('m365-readiness').textContent)
      .toBe('Signed in as new@corp.com. Select Add M365 target or Use this account to apply it.'))
    expect(posts()).toEqual(['POST /dashboard/api/m365/sign-in', 'POST /dashboard/api/m365/probe'])
    expect(fake.log[0]!.body).toEqual({ upn: 'new@corp.com' })
    expect(app.m365.drafts.registerAccount).toBe(broker.homeAccountId)
    expect(app.m365.drafts.account).toBe(broker.homeAccountId)
    expect(byId('m365-register-account')).toHaveValue(broker.homeAccountId)
  })

  it('lists readiness lines and disables sign-in when prerequisites are missing', async () => {
    const user = userEvent.setup()
    setup({ 'POST /dashboard/api/m365/probe': () => probeResult([], { platformSupported: false, helperAvailable: false, failedStep: 'platform', error: 'Windows is required.' }) })
    renderWith(m365Absent())
    expect(screen.getByRole('button', { name: 'Sign in another M365 account' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Check prerequisites' }))
    await waitFor(() => expect(byId('m365-readiness').querySelectorAll('li')).toHaveLength(4))
    const lines = Array.from(byId('m365-readiness').querySelectorAll('li'), item => item.textContent)
    expect(lines).toEqual(['Windows platform: required', 'msc-auth helper: not found', 'Broker accounts: 0', 'Windows is required.'])
    // Every line starts with an 8 px mark: a lamp, or an empty slot for a toneless line.
    for (const item of byId('m365-readiness').querySelectorAll('li'))
      expect(item.firstElementChild).toHaveClass(item.textContent === 'Broker accounts: 0' ? 'lamp-slot' : 'lamp')
    expect(screen.getByRole('button', { name: 'Sign in another M365 account' })).toBeDisabled()
  })

  it('makes Check prerequisites aria-disabled and hides sign-in when onboarding is unavailable', async () => {
    const user = userEvent.setup()
    renderWith(m365Absent({ onboarding: { status: 'unavailable' } }))
    expect(byId('m365-status').textContent).toBe('Onboarding is unavailable for this process.')
    expect(byId('m365-status')).not.toHaveClass('sr-only')
    expect(screen.queryByRole('button', { name: 'Sign in another M365 account' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Microsoft sign-in' })).toBeNull()
    const check = screen.getByRole('button', { name: 'Check prerequisites' })
    expect(check).toHaveAttribute('aria-disabled', 'true')
    expect(check).toHaveAccessibleDescription('Onboarding is unavailable for this process.')
    await user.click(check)
    expect(byId('m365-endpoint')).toBeDisabled()
    expect(byId('m365-custom-endpoint-save')).toBeDisabled()
    expect(fake.log).toHaveLength(0)
    expect(byId('m365-panel')).toHaveTextContent('unavailable')
  })
})

it('keeps M365 load errors in #m365-status and never raises a fault', async () => {
  setup({ '/dashboard/api/m365': () => jsonError(500, 'M365 exploded') })
  render(M365Panel)
  await loadAllViews()
  await waitFor(() => expect(byId('m365-status').textContent).toBe('M365 exploded'))
  expect(byId('m365-status')).toHaveClass('is-error')
  expect(faults).toEqual({})
})
