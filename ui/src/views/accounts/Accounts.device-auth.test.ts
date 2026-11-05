import type { AccountAuthenticationSession } from '@contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_AUTH_POLL_MS } from '../../lib/device-auth.svelte.ts'
import { faults } from '../../lib/store.svelte.ts'
import { jsonError } from '../../test/fake-fetch.ts'
import { authSession, renderAccounts, resetAccountsState } from '../../test/fixtures-accounts.ts'
import { account, accountsRouting } from '../../test/fixtures.ts'
import Accounts from '../Accounts.svelte'

const envelope = { schemaVersion: 1 as const, generatedAt: '2026-11-05T14:02:11.000Z' }
let pollState: () => AccountAuthenticationSession | Response
let start: AccountAuthenticationSession
let added = false
// A fresh id per test: card focus is claimed once per session id, module-wide.
let sessionCount = 0
let sessionId = ''
const session = (overrides: Partial<AccountAuthenticationSession> = {}) => authSession({ id: sessionId, ...overrides })
const pollPath = () => `/dashboard/api/account-auth/${sessionId}`

function routes() {
  return {
    '/dashboard/api/accounts': () => accountsRouting(added ? { accounts: [...accountsRouting().accounts, account({ name: 'team', hostname: 'team.localhost' })] } : {}),
    'POST /dashboard/api/accounts': () => Response.json({ ...envelope, authentication: start }, { status: 202 }),
    [pollPath()]: () => {
      const result = pollState()
      return result instanceof Response ? result : { ...envelope, authentication: result }
    },
  }
}

const form = () => document.getElementById('account-add-form') as HTMLFormElement
const submitButton = () => screen.getByRole('button', { name: 'Authenticate with GitHub' })
const status = () => document.getElementById('account-add-status')!

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
  await tick()
}

async function submit(name = 'Team') {
  const nameInput = document.getElementById('account-name') as HTMLInputElement
  await fireEvent.input(nameInput, { target: { value: name } })
  await fireEvent.submit(form())
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  resetAccountsState()
  added = false
  sessionId = `auth-${++sessionCount}`
  start = session()
  pollState = () => session()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('add GitHub account: device authorization (T:431-450)', () => {
  it('renders only public fields, an https link, and moves focus to Copy code', async () => {
    start = { ...session(), device_code: 'secret-device-code' } as AccountAuthenticationSession
    const { fake } = await renderAccounts(routes())
    await submit()
    expect(fake.log.find(request => request.method === 'POST')!.body).toEqual({ accountName: 'Team', hostname: 'team.localhost', gheDomain: '' })
    const card = document.getElementById('account-auth')!
    expect(card).toHaveTextContent('ABCD-1234')
    expect(card).not.toHaveTextContent('secret-device-code')
    expect(document.body).not.toHaveTextContent('device_code')
    expect(screen.getByRole('link', { name: /Open GitHub device login/ })).toHaveAttribute('href', 'https://github.com/login/device')
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveFocus()
    expect(card).toHaveTextContent('pending')
    expect(card).toHaveTextContent('Waiting for authorization')
    expect(card).toHaveTextContent('Code expires in 15:00')
    expect(status()).toHaveTextContent('Authorize in GitHub')
  })

  it('renders no link for a non-https verification URI but still shows the code', async () => {
    start = session({ authorization: { ...session().authorization, verificationUri: 'javascript:alert(1)' } })
    await renderAccounts(routes())
    await submit()
    expect(document.getElementById('account-auth')).toHaveTextContent('ABCD-1234')
    expect(screen.queryByRole('link', { name: /Open GitHub device login/ })).not.toBeInTheDocument()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('keeps the form disabled past the countdown until a terminal poll, then reloads and focuses the new target', async () => {
    start = session({ authorization: { ...session().authorization, expiresAt: new Date(Date.now() + 2500).toISOString() } })
    pollState = () => start
    const { fake } = await renderAccounts(routes())
    await submit()
    expect(submitButton()).toBeDisabled()
    await settle(4 * DEVICE_AUTH_POLL_MS)
    expect(document.getElementById('account-auth')).toHaveTextContent('Code expired. If GitHub didn\'t accept it, start again once this attempt ends.')
    expect(submitButton()).toBeDisabled()
    expect(document.getElementById('account-name')).toBeDisabled()
    expect(fake.count('GET', pollPath())).toBe(4)

    added = true
    pollState = () => ({ ...start, state: 'succeeded' })
    fake.clear()
    await settle(DEVICE_AUTH_POLL_MS)
    await settle()
    expect(status()).toHaveTextContent('Account added')
    expect(submitButton()).not.toBeDisabled()
    expect((document.getElementById('account-name') as HTMLInputElement).value).toBe('')
    expect(fake.calls()).toContain('GET /dashboard/api/accounts')
    expect(document.getElementById('target-team')).toHaveFocus()
    // Terminal: no further polls.
    fake.clear()
    await settle(3 * DEVICE_AUTH_POLL_MS)
    expect(fake.count('GET', pollPath())).toBe(0)
  })

  it('a remount mid-flow shows the same session and cannot start a second one', async () => {
    const { fake } = await renderAccounts(routes())
    await submit()
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveFocus()
    cleanup()
    render(Accounts)
    await settle()
    expect(document.getElementById('account-auth')).toHaveTextContent('ABCD-1234')
    expect(submitButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy code' })).not.toHaveFocus()
    await fireEvent.submit(form())
    await settle()
    expect(fake.count('POST', '/dashboard/api/accounts')).toBe(1)
  })

  it('a failed authentication re-enables the form with the values kept', async () => {
    pollState = () => ({ ...start, state: 'failed', message: 'The device code expired.' })
    await renderAccounts(routes())
    await submit()
    await settle(DEVICE_AUTH_POLL_MS)
    expect(status()).toHaveTextContent('Authentication failed')
    expect(screen.getByText('Check the details and select Authenticate with GitHub again.')).toBeInTheDocument()
    expect(document.getElementById('account-auth')).toHaveTextContent('The device code expired.')
    expect(submitButton()).not.toBeDisabled()
    expect((document.getElementById('account-name') as HTMLInputElement).value).toBe('Team')
  })

  it('a poll error stops polling, re-enables the form and raises the accounts fault', async () => {
    pollState = () => jsonError(404, 'Account authentication session was not found.')
    const { fake } = await renderAccounts(routes())
    await submit()
    await settle(DEVICE_AUTH_POLL_MS)
    expect(faults.accounts?.message).toBe('Account authentication session was not found.')
    expect(status()).toHaveTextContent('Account authentication session was not found.')
    expect(document.getElementById('account-auth')).not.toHaveTextContent('Waiting for authorization')
    expect(submitButton()).not.toBeDisabled()
    fake.clear()
    await settle(3 * DEVICE_AUTH_POLL_MS)
    expect(fake.log).toEqual([])
  })

  it('a start error reports in the status line', async () => {
    const { fake } = await renderAccounts({ ...routes(), 'POST /dashboard/api/accounts': () => jsonError(400, 'Account name is already in use.') })
    await submit()
    expect(status()).toHaveTextContent('Authentication could not start: Account name is already in use.')
    expect(faults.accounts?.message).toBe('Account name is already in use.')
    expect(submitButton()).not.toBeDisabled()
    expect(document.getElementById('account-auth')).toBeNull()
    expect(fake.count('POST')).toBe(1)
  })
})
