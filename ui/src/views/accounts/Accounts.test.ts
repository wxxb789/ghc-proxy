import { cleanup, fireEvent, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAccounts } from '../../lib/poller.svelte.ts'
import { faults } from '../../lib/store.svelte.ts'
import { jsonError } from '../../test/fake-fetch.ts'
import { renderAccounts, resetAccountsState, routingSummary } from '../../test/fixtures-accounts.ts'
import { account, accountsLegacy, accountsRouting } from '../../test/fixtures.ts'

const m365Account = account({
  name: 'm365',
  hostname: 'm365.localhost',
  upstream: 'm365',
  identity: 'user@corp.com',
  tenant: 'contoso.onmicrosoft.com',
  github: { status: 'not_applicable', accountType: 'individual' },
  quota: { status: 'not_applicable' },
})

const row = (name: string) => document.getElementById(`target-${name}`)!.closest('tr')!

beforeEach(resetAccountsState)

describe('accounts view: routing mode (T:346-374)', () => {
  it('shows hostname, login and tenant per row, never a credential, and the summary', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ accounts: [...accountsRouting().accounts, m365Account] }) })
    const work = row('work')
    expect(work).toHaveTextContent('work.localhost')
    expect(work).toHaveTextContent('octo-work')
    expect(work).toHaveTextContent('company.ghe.com')
    for (const tr of document.querySelectorAll('tbody tr'))
      expect(tr.textContent).not.toMatch(/token/i)
    expect(document.getElementById('accounts-summary')).toHaveTextContent('Base localhost / default personal')
    expect(screen.getByText('3 targets')).toBeInTheDocument()
    // The M365 identity (email) and tenant are visible in Targets; no GitHub health line.
    expect(row('m365')).toHaveTextContent('user@corp.com')
    expect(row('m365')).toHaveTextContent('contoso.onmicrosoft.com')
    expect(within(row('m365')).queryByText('GitHub')).not.toBeInTheDocument()
    expect(document.getElementById('account-add-form')).toBeInTheDocument()
    expect(document.getElementById('account-bootstrap-hostname')).not.toBeInTheDocument()
  })

  it('opens Details with derived URLs and the expires label', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ accounts: [...accountsRouting().accounts, m365Account] }) })
    const toggle = within(row('work')).getByRole('button', { name: 'Details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const details = document.getElementById('details-work')!
    expect(within(details).getByLabelText('Client base URL')).toHaveTextContent('http://work.localhost:4141')
    expect(within(details).getByLabelText('OpenAI base URL')).toHaveTextContent('http://work.localhost:4141/v1')
    expect(within(details).getByRole('link', { name: /Open this account's Dashboard/ })).toHaveAttribute('href', 'http://work.localhost:4141/dashboard')
    expect(details).toHaveTextContent('GitHub ok · business')
    expect(details).toHaveTextContent('Copilot ok · last refresh')

    await fireEvent.click(within(row('m365')).getByRole('button', { name: 'Details' }))
    const m365Details = document.getElementById('details-m365')!
    expect(m365Details).toHaveTextContent('Use the Client base URL in the M365 Copilot target panel.')
    expect(within(m365Details).queryByRole('link')).not.toBeInTheDocument()
  })

  it('remove is aria-disabled with a visible reason and sends nothing', async () => {
    const { fake } = await renderAccounts()
    const remove = within(row('personal')).getByRole('button', { name: 'Remove' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).not.toBeDisabled()
    expect(remove).toHaveAccessibleDescription('Choose another default account before removing this one.')
    expect(within(row('personal')).getByText('Choose another default account before removing this one.')).toBeVisible()
    expect(within(row('personal')).getByRole('button', { name: 'Default' })).toBeDisabled()
    fake.clear()
    await fireEvent.click(remove)
    await tick()
    expect(fake.log).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(row('work')).getByRole('button', { name: 'Remove' })).toHaveAttribute('title', 'Remove this account from ghc-proxy')
  })

  it('explains why the M365 target cannot be removed', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ defaultAccount: 'm365', accounts: [{ ...m365Account, isDefault: true }, account({ name: 'work', hostname: 'work.localhost' })] }) })
    expect(within(row('m365')).getByRole('button', { name: 'Remove' })).toHaveAccessibleDescription('Choose another default target before removing the M365 target.')
    expect(within(row('work')).getByRole('button', { name: 'Remove' })).not.toHaveAttribute('aria-disabled')

    cleanup()
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ accounts: [m365Account] }) })
    expect(within(row('m365')).getByRole('button', { name: 'Remove' })).toHaveAccessibleDescription('The M365 target is the only target and cannot be removed.')
  })

  it('set default posts the name, reloads accounts and reports in #accounts-status', async () => {
    let defaultAccount = 'personal'
    const { fake } = await renderAccounts({
      '/dashboard/api/accounts': () => accountsRouting({
        defaultAccount,
        accounts: accountsRouting().accounts.map(item => ({ ...item, isDefault: item.name === defaultAccount })),
      }),
      'POST /dashboard/api/accounts/default': ({ body }) => {
        defaultAccount = (body as { accountName: string }).accountName
        return routingSummary({ defaultAccount })
      },
    })
    fake.clear()
    await fireEvent.click(within(row('work')).getByRole('button', { name: 'Set default' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Default account is now work.'))
    expect(fake.log[0]).toMatchObject({ method: 'POST', path: '/dashboard/api/accounts/default', body: { accountName: 'work' }, contentType: 'application/json' })
    expect(fake.calls()).toContain('GET /dashboard/api/accounts')
    expect(document.getElementById('accounts-summary')).toHaveTextContent('Base localhost / default work')
    expect(within(row('work')).getByRole('button', { name: 'Default' })).toBeDisabled()
  })

  it('a failed Set default raises the accounts fault and says so', async () => {
    await renderAccounts({ 'POST /dashboard/api/accounts/default': () => jsonError(500, 'Default exploded') })
    await fireEvent.click(within(row('work')).getByRole('button', { name: 'Set default' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Couldn\'t set the default account: Default exploded'))
    expect(faults.accounts?.message).toBe('Default exploded')
    expect(screen.getByText(/Couldn't load Accounts: Default exploded/)).toBeInTheDocument()
  })
})

describe('accounts view: legacy mode (T:376-404)', () => {
  it('shows the bootstrap form in the Add slot with the suggested, editable hostname', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsLegacy() })
    const input = document.getElementById('account-bootstrap-hostname') as HTMLInputElement
    expect(input.value).toBe('default-account.localhost')
    expect(input).not.toBeDisabled()
    expect(document.body).toHaveTextContent('The suggested hostname is default-account.localhost. You can change this hostname before enabling.')
    expect(document.body).toHaveTextContent('After enabling, this page reopens at http://localhost:4141/dashboard#/accounts.')
    expect(document.getElementById('account-bootstrap-status')).toHaveTextContent('The current account remains the default.')
    expect(document.getElementById('account-add-form')).not.toBeInTheDocument()
    expect(document.getElementById('accounts-summary')).toHaveTextContent('Legacy default default / routing not enabled')

    await fireEvent.input(input, { target: { value: 'mine.localhost' } })
    await loadAccounts()
    await tick()
    expect((document.getElementById('account-bootstrap-hostname') as HTMLInputElement).value).toBe('mine.localhost')
  })
})

describe('accounts view: unavailable mode (409)', () => {
  it('shows the empty state, hides Add and Bootstrap and raises no fault', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => jsonError(409, 'Account management is unavailable for this process configuration.') })
    expect(document.getElementById('accounts-summary')).toHaveTextContent('Named-account management is unavailable')
    expect(screen.getByText(/This process was started without account management/)).toBeInTheDocument()
    expect(document.querySelector('table')).not.toBeInTheDocument()
    expect(document.getElementById('account-add-form')).not.toBeInTheDocument()
    expect(document.getElementById('account-bootstrap-hostname')).not.toBeInTheDocument()
    expect(faults).not.toHaveProperty('accounts')
  })
})
