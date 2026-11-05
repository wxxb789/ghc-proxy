import type { ReactNode } from 'react'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, useDashboard, useDashboardUrl } from '../../app/context'
import { navigateToHostname } from '../../lib/navigation'
import { authenticationFixture, createFakeFetch, deferred, m365Fixture, m365ReadinessFixture, m365SignInFixture, routingFixture, targetFixture, targetsFixture } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { TargetsPage } from './index'

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function NavigationBoundary({ children, destination }: { children: ReactNode, destination: (hostname: string) => void }) {
  const runtime = useDashboard()
  const navigation = useDashboardUrl()
  return (
    <NavigationContext value={{ ...navigation, goToHostname: async (hostname) => {
      await navigateToHostname({
        assign: url => destination(new URL(url).hostname),
        hostname,
        location: window.location,
        state: navigation.url,
        stop: runtime.stop,
      })
    } }}
    >
      {children}
    </NavigationContext>
  )
}

const otherTarget = targetFixture({ runtimeId: 'other-1', name: 'personal', hostname: 'personal.localhost', isDefault: false, actions: { canSetDefault: true, canRemove: true } })
const m365Target = targetFixture({ runtimeId: 'm365-1', name: 'm365', kind: 'm365', hostname: 'm365.localhost', tenant: 'organization', identity: 'operator@example.com', isDefault: false, health: { status: 'ok', github: { status: 'not_applicable' }, copilot: { status: 'ok', modelsLoaded: true } }, actions: { canSetDefault: true, canRemove: true }, client: { openAIBaseUrl: 'http://m365.localhost:4187/v1', anthropicBaseUrl: 'http://m365.localhost:4187', model: 'claude-opus' } })

describe('targets management', () => {
  it.each([
    { mode: 'implicit legacy', capabilities: { canAddAccount: false, canBootstrap: false, canManageM365: false, canRefreshMetadata: false }, routingEnabled: false, add: false, bootstrap: false, m365: false },
    { mode: 'manager routing off', capabilities: { canAddAccount: false, canBootstrap: true, canManageM365: true, canRefreshMetadata: false }, routingEnabled: false, add: false, bootstrap: true, m365: true },
    { mode: 'managed routing', capabilities: { canAddAccount: true, canBootstrap: false, canManageM365: true, canRefreshMetadata: true }, routingEnabled: true, add: true, bootstrap: false, m365: true },
    { mode: 'M365 only', capabilities: { canAddAccount: true, canBootstrap: false, canManageM365: true, canRefreshMetadata: true }, routingEnabled: true, add: true, bootstrap: false, m365: true },
  ])('uses the projected capability set in $mode', async ({ mode, capabilities, routingEnabled, add, bootstrap, m365 }) => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ capabilities, routing: { baseHostname: 'localhost', defaultAccount: mode === 'M365 only' ? 'm365' : 'work', routingEnabled }, targets: mode === 'M365 only' ? [targetFixture({ ...m365Target, isDefault: true, actions: { canSetDefault: false, canRemove: false } })] : [targetFixture()] })))
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    expect(Boolean(screen.queryByRole('button', { name: 'Add GitHub account' }))).toBe(add)
    expect(Boolean(screen.queryByRole('button', { name: 'Enable named routing' }))).toBe(bootstrap)
    expect(Boolean(screen.queryByRole('button', { name: 'Check prerequisites' }))).toBe(m365)
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(api.requests.some(request => request.method !== 'GET')).toBe(false)
  })

  it('unifies identity, health, default routing and client snippets without exposing credentials', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json({ ...targetsFixture({ targets: [targetFixture(), otherTarget, m365Target] }), privateCredential: 'PRIVATE-GITHUB-CREDENTIAL' }))
    renderDashboard({ api, url: '/dashboard/targets?target=personal', children: <TargetsPage /> })
    await settle()
    const table = screen.getByRole('table', { name: 'Route targets' })
    expect(within(table).getByRole('row', { name: /work.*operator/ })).toHaveTextContent('Default')
    expect(within(table).getByRole('row', { name: /m365.*operator@example.com/ })).toHaveTextContent('m365.localhost')
    expect(within(table).getAllByText('Healthy')).toHaveLength(3)
    expect(screen.queryByText('PRIVATE-GITHUB-CREDENTIAL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Client setup for m365'))
    fireEvent.click(screen.getByText('Client setup for work'))
    expect(screen.getByRole('button', { name: 'Copy OpenAI settings for m365' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy Anthropic settings for work' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Client setup for m365' })).toHaveTextContent('http://m365.localhost:4187/v1')
    expect(screen.getByRole('region', { name: 'Client setup for m365' })).toHaveTextContent('ANTHROPIC_BASE_URL=http://m365.localhost:4187')
    expect(screen.getByRole('region', { name: 'Client setup for work' })).toHaveTextContent('http://work.localhost:4141/v1')
    fireEvent.click(screen.getByRole('button', { name: 'Set personal as default' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/accounts/default'))?.body).toEqual({ accountName: 'personal' })
    expect(within(screen.getByRole('region', { name: 'Routing' })).getByText('Default target updated.')).toBeVisible()
  })

  it('starts device authentication with public fields and hands progress to the root task', async () => {
    const api = createFakeFetch()
    api.on('POST', '/dashboard/api/accounts', () => Response.json({ ...authenticationFixture(), device_code: 'PRIVATE-DEVICE-CODE' }))
    api.on('GET', '/dashboard/api/account-auth/auth-1', () => Response.json(authenticationFixture({ state: 'failed', message: 'Authorization expired.' })))
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Account name' }), { target: { value: 'personal' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub hostname' }), { target: { value: 'personal.localhost' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub Enterprise tenant (optional)' }), { target: { value: 'enterprise.example.com' } })
    const poll = deferred<Response>()
    api.on('GET', '/dashboard/api/account-auth/auth-1', () => poll.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Add GitHub account' }))
    await settle()
    expect(api.requests.find(request => request.method === 'POST' && request.url.pathname.endsWith('/accounts'))?.body).toEqual({ accountName: 'personal', hostname: 'personal.localhost', gheDomain: 'enterprise.example.com' })
    const auth = screen.getByRole('region', { name: 'GitHub authorization' })
    expect(auth).toHaveTextContent('ABCD-EFGH')
    expect(within(auth).getByRole('link', { name: 'Authorize on GitHub' })).toHaveAttribute('href', 'https://github.com/login/device')
    expect(auth).toHaveTextContent('Waiting for authorization')
    expect(screen.queryByText('PRIVATE-DEVICE-CODE')).not.toBeInTheDocument()
    expect(api.count('GET', '/dashboard/api/account-auth/auth-1')).toBe(1)
    poll.resolve(Response.json(authenticationFixture({ state: 'failed', message: 'Authorization expired.' })))
    await settle()
    expect(auth).toHaveTextContent('Authorization expired.')
  })

  it('requires a named confirmation, supports cancel, reports removal progress and redirects only for the opened hostname', async () => {
    const api = createFakeFetch()
    const removed = targetFixture({ ...otherTarget, hostname: window.location.hostname })
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), removed] })))
    const pending = deferred<Response>()
    api.on('DELETE', '/dashboard/api/accounts/personal', () => pending.promise)
    const destination = vi.fn()
    renderDashboard({ api, url: '/dashboard/targets?window=24h&target=work', children: <NavigationBoundary destination={destination}><TargetsPage /></NavigationBoundary> })
    await settle()
    screen.getByRole('button', { name: 'Remove personal' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Remove personal' }))
    let dialog = screen.getByRole('dialog', { name: 'Remove personal?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(api.count('DELETE', '/dashboard/api/accounts/personal')).toBe(0)
    expect(screen.getByRole('button', { name: 'Remove personal' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Remove personal' }))
    dialog = screen.getByRole('dialog', { name: 'Remove personal?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove personal' }))
    await settle()
    expect(within(dialog).getByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(destination).not.toHaveBeenCalled()
    pending.resolve(Response.json(routingFixture({ baseHostname: 'base.localhost' })))
    await settle()
    expect(destination).toHaveBeenCalledWith('base.localhost')
    const reads = api.requests.filter(request => request.method === 'GET').length
    await settle(30_000)
    expect(api.requests.filter(request => request.method === 'GET')).toHaveLength(reads)
  })

  it('keeps a failed removal inline and does not redirect based on the Monitor target filter', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), otherTarget] })))
    api.on('DELETE', '/dashboard/api/accounts/personal', () => Response.json({ error: { message: 'Account is busy.' } }, { status: 409 }))
    const destination = vi.fn()
    renderDashboard({ api, url: '/dashboard/targets?target=personal', children: <NavigationBoundary destination={destination}><TargetsPage /></NavigationBoundary> })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Remove personal' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove personal?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove personal' }))
    await settle()
    expect(dialog).toHaveTextContent('Account is busy.')
    api.on('DELETE', '/dashboard/api/accounts/personal', () => Response.json(routingFixture()))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove personal' }))
    await settle()
    expect(destination).not.toHaveBeenCalled()
    expect(screen.getByText('Removed personal.')).toBeVisible()
  })

  it('submits the edited bootstrap hostname and requests a root redirect to the returned base', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ routing: { baseHostname: 'localhost', defaultAccount: 'work', routingEnabled: false }, capabilities: { canBootstrap: true, canAddAccount: false, canManageM365: false, canRefreshMetadata: false }, targets: [targetFixture({ hostname: 'default-account.localhost' })] })))
    const destination = vi.fn()
    renderDashboard({ api, url: '/dashboard/targets?window=24h&target=work', children: <NavigationBoundary destination={destination}><TargetsPage /></NavigationBoundary> })
    await settle()
    expect(screen.getByRole('textbox', { name: 'Default account hostname' })).toHaveValue('default-account.localhost')
    fireEvent.change(screen.getByRole('textbox', { name: 'Default account hostname' }), { target: { value: 'primary.localhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable named routing' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/accounts/bootstrap'))?.body).toEqual({ hostname: 'primary.localhost' })
    expect(destination).toHaveBeenCalledWith('localhost')
  })
})

describe('m365 explicit onboarding', () => {
  it('explains non-Windows unavailability without sending a probe', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/m365', () => Response.json(m365Fixture({ platformSupported: false })))
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    expect(screen.getByRole('region', { name: 'M365 target' })).toHaveTextContent('Windows is required')
    expect(screen.queryByRole('button', { name: 'Check prerequisites' })).not.toBeInTheDocument()
    expect(api.count('POST', '/dashboard/api/m365/probe')).toBe(0)
  })

  it.each(['platform', 'helper', 'accounts'] as const)('names the failed %s readiness step and keeps typed hostname through mutation refetches', async (failedStep) => {
    const api = createFakeFetch()
    api.on('POST', '/dashboard/api/m365/probe', () => Response.json(m365ReadinessFixture({ failedStep, error: 'Readiness detail.' })))
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    expect(api.count('POST', '/dashboard/api/m365/probe')).toBe(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'M365 hostname' }), { target: { value: 'typed.localhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }))
    await settle()
    expect(screen.getByRole('region', { name: 'M365 target' })).toHaveTextContent(`Failed step: ${failedStep}`)
    expect(screen.getByText('Readiness detail.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'M365 hostname' })).toHaveValue('typed.localhost')
  })

  it('checks, signs in explicitly, selects a real broker account, registers and edits the target', async () => {
    const api = createFakeFetch()
    const account = { homeAccountId: 'home-2', upn: 'second@example.com', environment: 'login.microsoftonline.com' }
    let registered = false
    const state = () => m365Fixture({ registered, hostname: registered ? 'm365.localhost' : undefined, account: registered ? 'home-2' : undefined, username: registered ? account.upn : undefined, modelCount: registered ? 1 : 0, models: registered ? ['claude-opus'] : [], availability: registered ? { status: 'ready', updatedAt: 1 } : undefined })
    api.on('GET', '/dashboard/api/m365', () => Response.json(state()))
    api.on('POST', '/dashboard/api/m365/probe', () => Response.json(m365ReadinessFixture({ accountCount: 1, accounts: [account] })))
    api.on('POST', '/dashboard/api/m365/sign-in', () => Response.json(m365SignInFixture({ account })))
    api.on('POST', '/dashboard/api/m365/register', () => {
      registered = true
      return Response.json(state())
    })
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }))
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Sign-in email (optional)' }), { target: { value: account.upn } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Microsoft' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/m365/sign-in'))?.body).toEqual({ upn: account.upn })
    fireEvent.change(screen.getByRole('combobox', { name: 'Broker account' }), { target: { value: 'home-2' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'M365 hostname' }), { target: { value: 'typed.localhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add M365 target' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/m365/register'))?.body).toEqual({ hostname: 'typed.localhost', account: 'home-2' })
    const panel = screen.getByRole('region', { name: 'M365 target' })
    expect(panel).toHaveTextContent('claude-opus')
    expect(panel).toHaveTextContent('Ready')
    expect(screen.getByRole('textbox', { name: 'M365 hostname' })).toHaveValue('typed.localhost')
    fireEvent.click(screen.getByRole('button', { name: 'Save M365 hostname' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/m365/hostname'))?.body).toEqual({ hostname: 'typed.localhost' })
    fireEvent.click(screen.getByRole('button', { name: 'Use selected account' }))
    await settle()
    expect(api.requests.find(request => request.url.pathname.endsWith('/m365/account'))?.body).toEqual({ account: 'home-2' })
  })

  it('removes M365 through the named confirmation and renders mutation errors inline', async () => {
    const api = createFakeFetch()
    api.on('GET', '/dashboard/api/targets', () => Response.json(targetsFixture({ targets: [targetFixture(), m365Target] })))
    api.on('GET', '/dashboard/api/m365', () => Response.json(m365Fixture({ registered: true, hostname: 'm365.localhost', models: ['claude-opus'], modelCount: 1 })))
    api.on('POST', '/dashboard/api/m365/remove', () => Response.json({ error: { message: 'M365 could not be removed.' } }, { status: 503 }))
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Remove m365' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove m365?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove m365' }))
    await settle()
    expect(dialog).toHaveTextContent('M365 could not be removed.')
    expect(api.count('POST', '/dashboard/api/m365/remove')).toBe(1)
    expect(api.count('DELETE', '/dashboard/api/accounts/m365')).toBe(0)
  })

  it('keeps broker sign-in progress and errors inline, and preserves the hostname through explicit Refresh', async () => {
    const api = createFakeFetch()
    api.on('POST', '/dashboard/api/m365/probe', () => Response.json(m365ReadinessFixture()))
    const signIn = deferred<Response>()
    api.on('POST', '/dashboard/api/m365/sign-in', () => signIn.promise)
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'M365 hostname' }), { target: { value: 'keep-this.localhost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Microsoft' }))
    await settle()
    const panel = screen.getByRole('region', { name: 'M365 target' })
    expect(panel).toHaveTextContent('Complete sign-in in the Windows account dialog…')
    expect(screen.getByRole('button', { name: 'Sign in to Microsoft' })).toBeDisabled()
    signIn.resolve(Response.json({ error: { message: 'Microsoft sign-in was cancelled.' } }, { status: 502 }))
    await settle()
    expect(within(panel).getByText('Microsoft sign-in was cancelled.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('textbox', { name: 'M365 hostname' })).toHaveValue('keep-this.localhost')
    expect(api.count('POST', '/dashboard/api/m365/probe')).toBe(1)
    expect(api.count('POST', '/dashboard/api/m365/register')).toBe(0)
  })

  it('shows registration progress and the real server error without registering a fallback account', async () => {
    const api = createFakeFetch()
    api.on('POST', '/dashboard/api/m365/probe', () => Response.json(m365ReadinessFixture({ accountCount: 1, accounts: [{ upn: 'real@example.com', homeAccountId: 'real-home', environment: 'login.microsoftonline.com' }] })))
    const registration = deferred<Response>()
    api.on('POST', '/dashboard/api/m365/register', () => registration.promise)
    renderDashboard({ api, url: '/dashboard/targets', children: <TargetsPage /> })
    await settle()
    expect(screen.getByRole('button', { name: 'Add M365 target' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }))
    await settle()
    fireEvent.change(screen.getByRole('combobox', { name: 'Broker account' }), { target: { value: 'real-home' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add M365 target' }))
    await settle()
    const panel = screen.getByRole('region', { name: 'M365 target' })
    expect(panel).toHaveTextContent('Adding M365 target…')
    registration.resolve(Response.json({ error: { message: 'Broker token could not be acquired.' } }, { status: 502 }))
    await settle()
    expect(within(panel).getByText('Broker token could not be acquired.')).toBeVisible()
    expect(api.requests.find(request => request.url.pathname.endsWith('/m365/register'))?.body).toEqual({ account: 'real-home', hostname: 'm365.localhost' })
  })
})
