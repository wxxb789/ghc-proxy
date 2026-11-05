import { fireEvent } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from '../../lib/account-actions.svelte.ts'
import { faults, timers } from '../../lib/store.svelte.ts'
import { renderAccounts, resetAccountsState, routingSummary, spyLocation } from '../../test/fixtures-accounts.ts'
import { accountsLegacy } from '../../test/fixtures.ts'

const RAW_HOSTNAME = '  custom.localhost '

async function submitBootstrap(baseHostname: string, href: string) {
  const { fake } = await renderAccounts({
    '/dashboard/api/accounts': () => accountsLegacy(),
    'POST /dashboard/api/accounts/bootstrap': () => routingSummary({ baseHostname, defaultAccount: 'default' }),
  })
  const spy = spyLocation(href)
  page.location = spy.location
  timers.live = setInterval(() => {}, 2000)
  fake.clear()
  const input = document.getElementById('account-bootstrap-hostname') as HTMLInputElement
  await fireEvent.input(input, { target: { value: RAW_HOSTNAME } })
  await fireEvent.submit(input.form!)
  await vi.waitFor(() => expect(fake.count('POST')).toBe(1))
  return { fake, spy }
}

beforeEach(resetAccountsState)

describe('bootstrap named accounts (T:406-429)', () => {
  it.each(['127.0.0.1', '0.0.0.0', 'default-account.localhost'])('sends the raw hostname and reopens on localhost from %s', async (host) => {
    const { fake, spy } = await submitBootstrap('localhost', `http://${host}:4187/dashboard#/accounts`)
    const request = fake.log[0]!
    expect(request.path).toBe('/dashboard/api/accounts/bootstrap')
    expect(request.contentType).toBe('application/json')
    expect(JSON.stringify(request.body)).toBe(`{"hostname":"${RAW_HOSTNAME}"}`)
    await vi.waitFor(() => expect(spy.events).toEqual(['stopped=true', 'replace http://localhost:4187/dashboard#/accounts']))
  })

  it('does not redirect to an unexpected base hostname and records an accounts fault', async () => {
    const { spy } = await submitBootstrap('evil.example.com', 'http://127.0.0.1:4187/dashboard')
    await vi.waitFor(() => expect(faults.accounts?.message).toBe('Unexpected base hostname "evil.example.com". Open the Dashboard on that hostname manually.'))
    expect(spy.events).toEqual([])
  })

  it('a rejected bootstrap reports in its status line and keeps the value', async () => {
    const { fake } = await renderAccounts({
      '/dashboard/api/accounts': () => accountsLegacy(),
      'POST /dashboard/api/accounts/bootstrap': () => Response.json({ error: { message: 'Hostname is taken.' } }, { status: 400 }),
    })
    const input = document.getElementById('account-bootstrap-hostname') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'taken.localhost' } })
    await fireEvent.submit(input.form!)
    await vi.waitFor(() => expect(document.getElementById('account-bootstrap-status')).toHaveTextContent('Named-account routing could not be enabled: Hostname is taken.'))
    expect(faults.accounts?.message).toBe('Hostname is taken.')
    expect(input.value).toBe('taken.localhost')
    expect(input).not.toBeDisabled()
    expect(fake.count('POST')).toBe(1)
  })
})
