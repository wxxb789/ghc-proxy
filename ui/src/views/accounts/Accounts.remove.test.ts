import { fireEvent, screen, within } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from '../../lib/account-actions.svelte.ts'
import { timers } from '../../lib/store.svelte.ts'
import { renderAccounts, resetAccountsState, routingSummary, spyLocation } from '../../test/fixtures-accounts.ts'

const removeWork = { 'DELETE /dashboard/api/accounts/work': () => routingSummary() }
const workRow = () => document.getElementById('target-work')!.closest('tr')!

async function clickRemove() {
  await fireEvent.click(within(workRow()).getByRole('button', { name: 'Remove' }))
  const dialog = await screen.findByRole('dialog', { name: 'Remove work' })
  expect(dialog).toHaveTextContent('Remove work from ghc-proxy? This removes proxy configuration, not the upstream or Windows account.')
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  return dialog
}

beforeEach(resetAccountsState)

describe('remove a target (T:284-304)', () => {
  it('removing the account that serves this page stops timers, then reopens on the base hostname, same port', async () => {
    const { fake } = await renderAccounts(removeWork)
    const spy = spyLocation('http://work.localhost:4187/dashboard#/accounts')
    page.location = spy.location
    timers.live = setInterval(() => {}, 2000)
    timers.deviceAuth = setTimeout(() => {}, 1000)
    fake.clear()

    const dialog = await clickRemove()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(spy.events).toEqual(['stopped=true', 'replace http://localhost:4187/dashboard#/accounts']))
    expect(fake.calls()).toEqual(['DELETE /dashboard/api/accounts/work'])
    expect(fake.log[0]!.contentType).toBeNull()
  })

  it('removing the account that serves this page with an unexpected base hostname reports the outcome and the fault', async () => {
    const { fake } = await renderAccounts({ 'DELETE /dashboard/api/accounts/work': () => routingSummary({ baseHostname: 'evil.example.com' }) })
    const spy = spyLocation('http://work.localhost:4187/dashboard#/accounts')
    page.location = spy.location
    fake.clear()

    const dialog = await clickRemove()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Removed work.'))
    expect(spy.events).toEqual([])
    expect(screen.getByText(/Unexpected base hostname "evil\.example\.com"\. Open the Dashboard on that hostname manually\./)).toBeInTheDocument()
    // The removed origin answers 421 now, so nothing reloads from it.
    expect(fake.calls()).toEqual(['DELETE /dashboard/api/accounts/work'])
  })

  it('cancel sends no DELETE', async () => {
    const { fake } = await renderAccounts(removeWork)
    fake.clear()
    const dialog = await clickRemove()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await Promise.resolve()
    expect(fake.count('DELETE')).toBe(0)
  })

  it('removing another target reloads every view and reports the outcome', async () => {
    const { fake } = await renderAccounts(removeWork)
    const spy = spyLocation('http://localhost:4187/dashboard#/accounts')
    page.location = spy.location
    fake.clear()
    const dialog = await clickRemove()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Removed work.'))
    expect(spy.events).toEqual([])
    expect(fake.calls()).toEqual(expect.arrayContaining(['DELETE /dashboard/api/accounts/work', 'GET /dashboard/api/overview', 'GET /dashboard/api/accounts', 'GET /dashboard/api/requests']))
    expect(document.getElementById('targets-h')).toHaveFocus()
  })

  it('a failed remove keeps the page and says so', async () => {
    await renderAccounts({ 'DELETE /dashboard/api/accounts/work': () => Response.json({ error: { message: 'Busy' } }, { status: 500 }) })
    const dialog = await clickRemove()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Couldn\'t remove work: Busy'))
    expect(screen.getByText(/Couldn't load Accounts: Busy/)).toBeInTheDocument()
  })
})
