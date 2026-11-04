import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { ConfirmDialog } from './dialog'
import { ChartFrame, Region } from './primitives'

function RemovalFlow() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Remove work</button>
      <ConfirmDialog open={open} targetName="work" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)} />
    </>
  )
}

describe('shared semantic components', () => {
  it('uses a named native confirmation dialog and returns focus after Escape', async () => {
    const user = userEvent.setup()
    render(<RemovalFlow />)
    const trigger = screen.getByRole('button', { name: 'Remove work' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: /Remove work/ })
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Remove work' })).toBeVisible()
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('reveals an accessible numeric table through the native disclosure', async () => {
    const user = userEvent.setup()
    render(
      <ChartFrame
        title="Requests over time"
        summary="Eight requests: six completed, one failed and one aborted."
        caption="Request values"
        rows={[{ time: '10:00', completed: 6, failed: 1, aborted: 1 }]}
        rowKey={row => row.time}
        columns={[
          { key: 'time', header: 'Time', render: row => row.time },
          { key: 'completed', header: 'Completed', render: row => row.completed, numeric: true },
          { key: 'failed', header: 'Failed', render: row => row.failed, numeric: true },
          { key: 'aborted', header: 'Aborted', render: row => row.aborted, numeric: true },
        ]}
      >
        <div aria-label="Plot surface" />
      </ChartFrame>,
    )
    const figure = screen.getByRole('figure', { name: 'Requests over time' })
    expect(within(figure).getByRole('table', { hidden: true })).not.toBeVisible()
    await user.click(within(figure).getByText('View numeric data'))
    const table = screen.getByRole('table', { name: 'Request values' })
    expect(table).toBeVisible()
  })

  it('keeps zero data distinct from empty and retains last data beside a source error', () => {
    const { rerender } = render(<Region title="Count" result={{ state: 'ready', data: 0, error: null }}>{count => <p aria-label="Value">{count}</p>}</Region>)
    expect(screen.getByLabelText('Value')).toHaveTextContent('0')
    rerender(<Region title="Count" result={{ state: 'empty', data: 0, error: null }} empty="No collected samples">{count => <p aria-label="Value">{count}</p>}</Region>)
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument()
    expect(screen.getByText('No collected samples')).toBeVisible()
    rerender(<Region title="Count" result={{ state: 'stale', data: 8, error: new Error('Quota source failed') }}>{count => <p aria-label="Value">{count}</p>}</Region>)
    expect(screen.getByLabelText('Value')).toHaveTextContent('8')
    expect(screen.getByText('Quota source failed')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
