/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAccounts } from '../../lib/poller.svelte.ts'
import { faults } from '../../lib/store.svelte.ts'
import { jsonError } from '../../test/fake-fetch.ts'
import { renderAccounts, resetAccountsState, routingSummary } from '../../test/fixtures-accounts.ts'
import { account, accountsLegacy, accountsRouting, quota } from '../../test/fixtures.ts'

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
/** The `<dd>` of a Details kv row. */
const kv = (root: HTMLElement, label: string) => within(root).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement

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
    expect(document.getElementById('accounts-summary')!.textContent).toBe('Base hostname localhost')
    expect(screen.queryByText(/\d targets?$/)).not.toBeInTheDocument()
    // Normal rows carry no "models loaded" caption, and two unlimited pools share one line.
    expect(work).not.toHaveTextContent('models loaded')
    expect(within(work).getByText('Chat · Completions Unlimited')).toBeInTheDocument()
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
    // Statuses live in the Health column; Details keeps the times (no seconds) and the account type.
    expect(details).not.toHaveTextContent('GitHub ok')
    expect(kv(details, 'Validated')).toHaveTextContent(/^—none · business$/)
    expect(kv(details, 'Copilot refresh')).toHaveTextContent(/^\d\d:\d\d$/)

    await fireEvent.click(within(row('personal')).getByRole('button', { name: 'Details' }))
    expect(kv(document.getElementById('details-personal')!, 'Validated')).toHaveTextContent(/^\d\d:\d\d · individual$/)

    await fireEvent.click(within(row('m365')).getByRole('button', { name: 'Details' }))
    const m365Details = document.getElementById('details-m365')!
    expect(within(m365Details).getByRole('link', { name: 'Open M365 settings' })).toHaveAttribute('href', '#/accounts?section=m365')
    expect(m365Details).not.toHaveTextContent('Use the Client base URL')
    expect(within(m365Details).queryByText('Validated')).not.toBeInTheDocument()
    expect(kv(m365Details, 'Copilot refresh')).toBeInTheDocument()
  })

  it('flags a failed refresh, the expiry, unloaded models and metered pools', async () => {
    const copilot = { status: 'degraded' as const, modelsLoaded: false, lastRefreshAt: '2026-11-05T14:02:00.000Z', lastRefreshSucceeded: false, expiresAt: '2026-11-05T15:00:00.000Z' }
    const metered = { entitlement: 300, remaining: 120, percentRemaining: 40, unlimited: false, overagePermitted: false }
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ accounts: [account({ name: 'personal', isDefault: true, copilot, quota: quota({ chat: metered }) })] }) })
    const personal = row('personal')
    expect(within(personal).getByText('models unavailable')).toHaveClass('fg-warn')
    expect(personal).toHaveTextContent('Chat 120 / 300')
    expect(personal).toHaveTextContent('Completions Unlimited')
    await fireEvent.click(within(personal).getByRole('button', { name: 'Details' }))
    const refresh = kv(document.getElementById('details-personal')!, 'Copilot refresh')
    expect(refresh).toHaveTextContent(/^\d\d:\d\d failed · expires \d\d:\d\d$/)
    expect(within(refresh).getByText('failed')).toHaveClass('fg-warn')
  })

  it('remove is aria-disabled with a visible reason and sends nothing', async () => {
    const { fake } = await renderAccounts()
    const remove = within(row('personal')).getByRole('button', { name: 'Remove' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).not.toBeDisabled()
    expect(remove).toHaveAccessibleDescription('Choose another default account before removing this one.')
    expect(within(row('personal')).getByText('Choose another default account before removing this one.')).toBeVisible()
    // The default row has only the default tag and Remove: no disabled "Default" button.
    expect(within(row('personal')).getAllByRole('button').map(button => button.textContent)).toEqual(['Details', 'Remove'])
    expect(within(row('personal')).getByText('default')).toBeInTheDocument()
    fake.clear()
    await fireEvent.click(remove)
    await tick()
    expect(fake.log).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(row('work')).getByRole('button', { name: 'Remove' })).not.toHaveAttribute('title')
  })

  it('explains that a sole GitHub target cannot be removed', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsRouting({ accounts: [account({ name: 'personal', hostname: 'personal.localhost', isDefault: true })] }) })
    expect(within(row('personal')).getByRole('button', { name: 'Remove' })).toHaveAccessibleDescription('This is the only target and cannot be removed.')
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
    expect(document.getElementById('accounts-summary')!.textContent).toBe('Base hostname localhost')
    expect(within(row('work')).queryByRole('button', { name: 'Set default' })).not.toBeInTheDocument()
    expect(within(row('personal')).getByRole('button', { name: 'Set default' })).toBeEnabled()
  })

  it('a failed Set default raises the accounts fault and says so', async () => {
    await renderAccounts({ 'POST /dashboard/api/accounts/default': () => jsonError(500, 'Default exploded') })
    await fireEvent.click(within(row('work')).getByRole('button', { name: 'Set default' }))
    await vi.waitFor(() => expect(document.getElementById('accounts-status')).toHaveTextContent('Couldn\'t set the default account: Default exploded'))
    expect(faults.accounts?.message).toBe('Default exploded')
    expect(screen.getByText(/Couldn't load Accounts: Default exploded/)).toBeInTheDocument()
    // The panel's own fault strip is its one staleness indicator: no extra stale tag.
    expect(within(screen.getByRole('region', { name: 'Targets' })).queryByText('stale')).not.toBeInTheDocument()
  })
})

describe('accounts view: legacy mode (T:376-404)', () => {
  it('shows the bootstrap form in the Add slot with the suggested, editable hostname', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => accountsLegacy() })
    const input = document.getElementById('account-bootstrap-hostname') as HTMLInputElement
    expect(input.value).toBe('default-account.localhost')
    expect(input).not.toBeDisabled()
    expect(input).toHaveAccessibleDescription('The current account remains the default. After enabling, this page reopens at http://localhost:4141/dashboard#/accounts.')
    // The status line is for progress and errors only; the header meta is empty (the panel states the mode).
    expect(document.getElementById('account-bootstrap-status')!.textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Enable named accounts' })).toBeEnabled()
    expect(document.getElementById('account-add-form')).not.toBeInTheDocument()
    expect(document.getElementById('accounts-summary')!.textContent).toBe('')

    await fireEvent.input(input, { target: { value: 'mine.localhost' } })
    await loadAccounts()
    await tick()
    expect((document.getElementById('account-bootstrap-hostname') as HTMLInputElement).value).toBe('mine.localhost')
  })
})

describe('accounts view: unavailable mode (409)', () => {
  it('shows the empty state, hides Add and Bootstrap and raises no fault', async () => {
    await renderAccounts({ '/dashboard/api/accounts': () => jsonError(409, 'Account management is unavailable for this process configuration.') })
    // The empty state says it; the header meta stays mounted but empty.
    expect(document.getElementById('accounts-summary')!.textContent).toBe('')
    expect(screen.getByText('Named-account management is unavailable')).toBeInTheDocument()
    expect(screen.getByText(/This process was started without account management/)).toBeInTheDocument()
    expect(document.querySelector('table')).not.toBeInTheDocument()
    expect(document.getElementById('account-add-form')).not.toBeInTheDocument()
    expect(document.getElementById('account-bootstrap-hostname')).not.toBeInTheDocument()
    expect(faults).not.toHaveProperty('accounts')
  })
})

// Read from disk: Vitest does not process component CSS, and jsdom does no layout or media queries.
describe('targets card styles', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Targets.svelte'), 'utf8').split('<style>')[1]!

  it('drops the ≤560 TARGET/ACTIONS captions with a selector that outranks the later global reflow label', () => {
    // app.css `.table:not(.no-reflow) td[data-label]::before` is (0,3,2) and is bundled after component CSS,
    // so the scoped override needs [data-label] too: `.targets.svelte-x td[data-label]:is(…)::before` is (0,4,2).
    expect(css).toMatch(/@media \(max-width: 560px\) \{[^@]*\.targets td\[data-label\]:is\(:first-child, :last-child\)::before \{ content: none; \}/)
  })

  it('lines the Details Dashboard link up with the URL code boxes, not their reserved status lines', () => {
    expect(css).toMatch(/\.urls \{[^}]*align-items: center;/)
  })
})
