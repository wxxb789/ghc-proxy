import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { metricsFixture } from '../../test/fixtures'
import { BreakdownChart, HistogramChart, LatencyChart, RequestsChart } from './index'

describe('monitor chart seam', () => {
  it('keeps a selected dimension through reordering and traverses the new displayed order', () => {
    const first = [{ kind: 'named' as const, value: 'alpha', requests: 9, failures: 1 }, { kind: 'named' as const, value: 'beta', requests: 4, failures: 0 }]
    const { rerender } = render(<BreakdownChart title="Models" metrics={metricsFixture()} source={first} />)
    const plot = screen.getByRole('group', { name: 'Models interactive plot' })
    fireEvent.focus(plot)
    expect(screen.getByLabelText('Models selected value')).toHaveTextContent('alpha: 9 requests')
    fireEvent.keyDown(plot, { key: 'End' })
    expect(screen.getByLabelText('Models selected value')).toHaveTextContent('beta: 4 requests')
    rerender(<BreakdownChart title="Models" metrics={metricsFixture()} source={[{ ...first[1]!, requests: 12 }, first[0]!]} />)
    expect(screen.getByLabelText('Models selected value')).toHaveTextContent('beta: 12 requests')
    fireEvent.keyDown(plot, { key: 'ArrowDown' })
    expect(screen.getByLabelText('Models selected value')).toHaveTextContent('alpha: 9 requests')
    fireEvent.keyDown(plot, { key: 'Home' })
    expect(screen.getByLabelText('Models selected value')).toHaveTextContent('beta: 12 requests')
    fireEvent.keyDown(plot, { key: 'Escape' })
    expect(screen.queryByLabelText('Models selected value')).not.toBeInTheDocument()
  })

  it('provides actual numeric rows including null latency and not-collected coverage', () => {
    const base = metricsFixture()
    const bucket = base.series[0]!
    const metrics = metricsFixture({ series: [
      { ...bucket, startMs: base.startMs, endMs: base.startMs + base.bucketMs, coverage: 'not-collected' },
      { ...bucket, coverage: 'open', counts: { completed: 0, failed: 1, aborted: 1 }, latency: { count: 0, sumMs: 0, p50: null, p95: null } },
    ] })
    render(
      <>
        <RequestsChart metrics={metrics} />
        <LatencyChart metrics={metrics} />
      </>,
    )
    const requests = screen.getByRole('figure', { name: 'Requests over time' })
    const latency = screen.getByRole('figure', { name: 'Latency over time' })
    fireEvent.click(within(requests).getByText('View numeric data'))
    fireEvent.click(within(latency).getByText('View numeric data'))
    expect(within(requests).getByRole('table')).toHaveTextContent('Not collected')
    expect(within(requests).getByRole('table')).toHaveTextContent('In progress')
    const terminalRows = within(within(requests).getByRole('table')).getAllByRole('row')
    expect(within(terminalRows[2]!).getAllByRole('cell').slice(1).map(cell => cell.textContent)).toEqual(['In progress', '0', '1', '1', '2'])
    const latencyRows = within(within(latency).getByRole('table')).getAllByRole('row')
    expect(latencyRows[2]).toHaveTextContent('No samples')
    expect(latencyRows[2]).toHaveTextContent('0')
    const plot = within(requests).getByRole('group', { name: 'Requests over time interactive plot' })
    fireEvent.keyDown(plot, { key: 'End' })
    expect(within(requests).getByLabelText('Requests over time selected value')).toHaveTextContent('0 completed, 1 failed, 1 aborted')
    const latencyPlot = within(latency).getByRole('group', { name: 'Latency over time interactive plot' })
    fireEvent.focus(latencyPlot)
    expect(within(latency).getByLabelText('Latency over time selected value')).toHaveTextContent('Not collected')
    fireEvent.keyDown(latencyPlot, { key: 'ArrowRight' })
    expect(within(latency).getByLabelText('Latency over time selected value')).toHaveTextContent('No samples')
    expect(within(latency).getByLabelText('Latency over time selected value')).toHaveTextContent('0 observed completed-request samples')
    fireEvent.keyDown(latencyPlot, { key: 'Escape' })
    expect(within(latency).queryByLabelText('Latency over time selected value')).not.toBeInTheDocument()
  })

  it('preserves the full 24h axis and explains collection two minutes after startup', () => {
    const endMs = Date.parse('2026-11-04T00:02:00Z')
    const startMs = endMs - 86_400_000
    const sample = metricsFixture().series[0]!
    const metrics = metricsFixture({
      window: '24h',
      startMs,
      endMs,
      coveredMs: 120_000,
      series: Array.from({ length: 96 }, (_, index) => ({
        ...sample,
        startMs: startMs + index * 900_000,
        endMs: startMs + (index + 1) * 900_000,
        coverage: index === 95 ? 'open' : 'not-collected',
      })),
    })
    render(<RequestsChart metrics={metrics} />)
    const figure = screen.getByRole('figure', { name: 'Requests over time' })
    expect(within(figure).getByText(/Not collected before/)).toBeVisible()
    expect(within(figure).getByText(/24h window:/)).toHaveTextContent('Collection began')
    expect(within(figure).getByLabelText('Window start')).toHaveAttribute('dateTime', new Date(startMs).toISOString())
    expect(within(figure).getByLabelText('Window end')).toHaveAttribute('dateTime', new Date(endMs).toISOString())
    expect(within(figure).getByLabelText('Collection start boundary')).toHaveAttribute('dateTime', metrics.collectionStartedAt)
  })

  it('navigates histogram intervals and retains timestamp keys when a new bucket arrives', () => {
    const metrics = metricsFixture()
    const { rerender } = render(
      <>
        <RequestsChart metrics={metrics} />
        <HistogramChart metrics={metrics} />
      </>,
    )
    const timePlot = screen.getByRole('group', { name: 'Requests over time interactive plot' })
    fireEvent.keyDown(timePlot, { key: 'End' })
    const selected = screen.getByLabelText('Requests over time selected value').textContent
    const bucket = metrics.series[0]!
    rerender(
      <>
        <RequestsChart metrics={{ ...metrics, series: [bucket, { ...bucket, startMs: bucket.endMs, endMs: bucket.endMs + metrics.bucketMs }] }} />
        <HistogramChart metrics={metrics} />
      </>,
    )
    expect(screen.getByLabelText('Requests over time selected value')).toHaveTextContent(selected!)
    const histogram = screen.getByRole('group', { name: 'Latency distribution interactive plot' })
    fireEvent.keyDown(histogram, { key: 'Home' })
    expect(screen.getByLabelText('Latency distribution selected value')).toHaveTextContent('Up to')
    fireEvent.keyDown(histogram, { key: 'End' })
    expect(screen.getByLabelText('Latency distribution selected value')).toHaveTextContent('Over')
    const updated = { ...metrics, latency: { ...metrics.latency, count: 8, histogram: [...metrics.latency.histogram.slice(0, -1), 2] } }
    rerender(
      <>
        <RequestsChart metrics={{ ...metrics, series: [bucket, { ...bucket, startMs: bucket.endMs, endMs: bucket.endMs + metrics.bucketMs }] }} />
        <HistogramChart metrics={updated} />
      </>,
    )
    expect(screen.getByLabelText('Latency distribution selected value')).toHaveTextContent('2 observed completed-request samples')
    fireEvent.keyDown(histogram, { key: 'ArrowLeft' })
    fireEvent.keyDown(histogram, { key: 'Escape' })
    expect(screen.queryByLabelText('Latency distribution selected value')).not.toBeInTheDocument()
  })

  it('clears plot selection when collection restarts instead of attaching it to a new session', () => {
    const metrics = metricsFixture()
    const { rerender } = render(<LatencyChart metrics={metrics} />)
    fireEvent.keyDown(screen.getByRole('group', { name: 'Latency over time interactive plot' }), { key: 'End' })
    expect(screen.getByLabelText('Latency over time selected value')).toHaveTextContent('≈ 500 ms')
    rerender(<LatencyChart metrics={{ ...metrics, collectionStartedAt: '2026-11-04T00:01:00Z' }} />)
    expect(screen.queryByLabelText('Latency over time selected value')).not.toBeInTheDocument()
  })
})
