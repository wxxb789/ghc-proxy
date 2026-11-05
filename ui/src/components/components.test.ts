import { fireEvent, render } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app, raiseFault } from '../lib/store.svelte.ts'
import { clearFaults } from '../test/fixtures.ts'
import FaultStrip from './FaultStrip.svelte'
import IssueRow from './IssueRow.svelte'
import Segmented from './Segmented.svelte'

// Svelte trims whitespace at the start of a block, so a leading space inside `{#if}` is lost.
describe('inline text spacing across conditional blocks', () => {
  beforeEach(() => {
    clearFaults()
    app.loadedAt.models = null
  })

  it('separates the fault message from the last-loaded time', () => {
    app.loadedAt.models = new Date(2026, 10, 5, 3, 50, 30)
    raiseFault('models', new Error('Boom.'))
    const { container } = render(FaultStrip, { scope: 'models' })
    expect(container.querySelector('.fault-strip p')?.textContent).toBe('Couldn\'t load Models: Boom. Showing data from 03:50:30.')
  })

  it('separates an issue body from its as-of time and the since time from the count', () => {
    const at = new Date(2026, 10, 5, 3, 50, 30)
    const { container } = render(IssueRow, { issue: { id: 'x', tone: 'warn', title: 'T', body: 'Body.', asOf: at, since: at, count: 3, actions: [] } })
    expect(container.querySelector('.issue-body')?.textContent).toBe('Body. as of 03:50:30')
    expect(container.querySelector('.issue-meta')?.textContent).toBe('since 03:50 · ×3')
  })

  it('separates a segment label from its count in the accessible name', () => {
    const { getByRole } = render(Segmented<'all'>, { label: 'State', options: [{ value: 'all', label: 'All', count: 65 }], value: 'all', onchange: () => {} })
    expect(getByRole('radio').textContent?.trim()).toBe('All 65')
  })
})

describe('issue row actions', () => {
  it('shows Refresh metadata as unavailable with its reason, and the click does nothing', async () => {
    app.accountsMode = 'legacy'
    const onaction = vi.fn()
    const { getByRole, getByText } = render(IssueRow, { issue: { id: 'Q3', tone: 'warn', title: 'T', actions: [{ label: 'Refresh metadata', kind: 'refresh' }] }, onaction })
    const button = getByRole('button', { name: 'Refresh metadata' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription('Available after named accounts are enabled')
    expect(getByText('Available after named accounts are enabled')).toBeVisible()
    await fireEvent.click(button)
    expect(onaction).not.toHaveBeenCalled()
    app.accountsMode = 'unknown'
  })
})
