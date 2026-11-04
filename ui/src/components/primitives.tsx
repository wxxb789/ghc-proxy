import type { DashboardRequestState } from '@contract'
import type { ReactNode } from 'react'
import type { RegionResult } from '../lib/poll'
import { useId } from 'react'

export interface CardProps { title?: string, description?: string, children: ReactNode, actions?: ReactNode }
export function Card({ title, description, children, actions }: CardProps) {
  const heading = useId()
  return (
    <section className="card" aria-labelledby={title ? heading : undefined}>
      {(title || actions) && (
        <div className="section-heading">
          <div>
            {title && <h2 id={heading}>{title}</h2>}
            {description && <p className="muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export interface StatusChipProps {
  state: DashboardRequestState | 'ok' | 'degraded' | 'unavailable' | 'stale' | 'pending' | 'unknown' | 'missing' | 'not_applicable'
  children?: ReactNode
}
const STATUS: Record<StatusChipProps['state'], { symbol: string, label: string, tone: string }> = {
  completed: { symbol: '✓', label: 'Completed', tone: 'completed' },
  failed: { symbol: '×', label: 'Failed', tone: 'failed' },
  aborted: { symbol: '−', label: 'Aborted', tone: 'aborted' },
  in_flight: { symbol: '○', label: 'In flight', tone: 'completed' },
  streaming: { symbol: '↔', label: 'Streaming', tone: 'completed' },
  ok: { symbol: '✓', label: 'Healthy', tone: 'completed' },
  degraded: { symbol: '!', label: 'Degraded', tone: 'aborted' },
  unavailable: { symbol: '×', label: 'Unavailable', tone: 'failed' },
  stale: { symbol: '!', label: 'Stale', tone: 'aborted' },
  pending: { symbol: '○', label: 'Pending', tone: 'aborted' },
  unknown: { symbol: '?', label: 'Unknown', tone: 'neutral' },
  missing: { symbol: '!', label: 'Not configured', tone: 'aborted' },
  not_applicable: { symbol: '−', label: 'Not applicable', tone: 'neutral' },
}
export function StatusChip({ state, children }: StatusChipProps) {
  const status = STATUS[state]
  return (
    <span className={`status-chip tone-${status.tone}`}>
      <span aria-hidden="true">{status.symbol}</span>
      {children ?? status.label}
    </span>
  )
}

export interface RegionProps<T> {
  title: string
  result: RegionResult<T>
  children: (data: T) => ReactNode
  empty?: ReactNode
  unavailable?: ReactNode
  retry?: () => void
}
export function Region<T>({ title, result, children, empty = 'No data in this view yet.', unavailable = 'This data is not available.', retry }: RegionProps<T>) {
  const heading = useId()
  const hasData = result.data !== undefined
  return (
    <section className="region" aria-labelledby={heading} aria-busy={result.state === 'loading' || result.state === 'refreshing'}>
      <div className="section-heading">
        <h2 id={heading}>{title}</h2>
        {result.state === 'refreshing' && <span className="muted">Updating</span>}
      </div>
      {result.state === 'loading' && <p className="region-message">Loading data…</p>}
      {result.state === 'empty' && <div className="region-message">{empty}</div>}
      {result.state === 'unavailable' && <div className="region-message">{result.explanation ?? unavailable}</div>}
      {(result.state === 'error' || result.state === 'stale') && (
        <div className="region-warning">
          <strong>{result.state === 'stale' ? 'Showing last known data' : 'Could not update this region'}</strong>
          <p>{result.explanation ?? result.error?.message ?? 'The source is temporarily unavailable.'}</p>
          {retry && !result.explanation && <button type="button" onClick={retry}>Try again</button>}
        </div>
      )}
      {hasData && result.state !== 'empty' && result.state !== 'unavailable' && children(result.data as T)}
    </section>
  )
}

export interface TableColumn<T> { key: string, header: ReactNode, render: (row: T) => ReactNode, numeric?: boolean }
export interface DataTableProps<T> {
  caption: string
  columns: readonly TableColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  empty?: ReactNode
}
export function DataTable<T>({ caption, columns, rows, rowKey, empty = 'No matching results.' }: DataTableProps<T>) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map(column => <th key={column.key} scope="col" className={column.numeric ? 'numeric' : undefined}>{column.header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={columns.length}>{empty}</td></tr>
            : rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key} className={column.numeric ? 'numeric' : undefined}>{column.render(row)}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  )
}

export interface ChartFrameProps<T> extends DataTableProps<T> {
  title: string
  summary: string
  children: ReactNode
  collectionStartedAt?: string
}
export function ChartFrame<T>({ title, summary, children, collectionStartedAt, ...table }: ChartFrameProps<T>) {
  const heading = useId()
  const description = useId()
  return (
    <figure className="chart-frame" aria-labelledby={heading} aria-describedby={description}>
      <figcaption>
        <h3 id={heading}>{title}</h3>
        <p id={description} className="muted">{summary}</p>
        {collectionStartedAt && (
          <p className="muted">
            Collection began
            <time dateTime={collectionStartedAt}>{new Date(collectionStartedAt).toLocaleTimeString()}</time>
          </p>
        )}
      </figcaption>
      <div className="chart-plot">{children}</div>
      <details className="chart-table">
        <summary>View numeric data</summary>
        <DataTable {...table} />
      </details>
    </figure>
  )
}
