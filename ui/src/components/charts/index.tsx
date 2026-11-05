import type { DashboardBreakdown, DashboardMetrics } from '@contract'
import type { TimePoint } from '../../lib/series'
import type { TableColumn } from '../primitives'
import { memo, useId } from 'react'
import { Area, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { formatDateTime, formatDuration, formatInteger } from '../../lib/format'
import { buildBreakdown, buildHistogram, buildTimeSeries, metricSummary } from '../../lib/series'
import { ChartFrame } from '../primitives'
import { ChartSurface } from './surface'
import './monitor.css'

const tick = { fill: 'var(--ink-muted)', fontSize: 10.5 }
const ID_SAFE = /[^\w-]/g
const timeTick = (value: number) => new Date(value).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
const interval = (row: TimePoint) => `${formatDateTime(row.startMs)} – ${formatDateTime(row.endMs)}`
const count = (value: number | null) => value === null ? 'Not collected' : formatInteger(value)
const axisLine = false
const tickLine = false
const timeColumns: TableColumn<TimePoint>[] = [
  { key: 'interval', header: 'Interval', render: interval },
  { key: 'coverage', header: 'Coverage', render: row => row.coverage },
]

function TimeCoverage({ metrics }: { metrics: DashboardMetrics }) {
  const start = Date.parse(metrics.collectionStartedAt)
  return (
    <div className="monitor-coverage muted">
      <p aria-label="Displayed interval">
        Displayed interval:
        {' '}
        <time aria-label="Window start" dateTime={new Date(metrics.startMs).toISOString()}>{formatDateTime(metrics.startMs)}</time>
        {' '}
        –
        {' '}
        <time aria-label="Window end" dateTime={new Date(metrics.endMs).toISOString()}>{formatDateTime(metrics.endMs)}</time>
      </p>
      {start > metrics.startMs && (
        <p>
          Not collected before
          {' '}
          <time dateTime={metrics.collectionStartedAt}>{formatDateTime(start)}</time>
          ; this is not zero traffic.
        </p>
      )}
      <p>
        Collection start boundary:
        {' '}
        <time aria-label="Collection start boundary" dateTime={metrics.collectionStartedAt}>{formatDateTime(start)}</time>
        .
      </p>
      <p>{`Each bucket is ${formatDuration(metrics.bucketMs)}. Terminal states are recorded when the request completed in this interval, including failed and aborted requests. Open buckets are in progress; the first collected bucket may have partial-start coverage.`}</p>
    </div>
  )
}

function CoverageMarks({ metrics, patternId }: { metrics: DashboardMetrics, patternId: string }) {
  const collection = Date.parse(metrics.collectionStartedAt)
  return (
    <>
      <defs>
        <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border-strong)" strokeWidth="1.2" opacity="0.55" />
        </pattern>
      </defs>
      {collection > metrics.startMs && <ReferenceArea x1={metrics.startMs} x2={Math.min(collection, metrics.endMs)} fill={`url(#${patternId})`} fillOpacity={1} label={{ value: 'Not collected', fill: 'var(--ink-muted)', fontSize: 10 }} />}
      {metrics.series.filter(bucket => bucket.coverage === 'open' || bucket.coverage === 'partial-start').map(bucket => (
        <ReferenceArea key={bucket.startMs} x1={Math.max(bucket.startMs, collection)} x2={bucket.endMs} fill="var(--aborted)" fillOpacity={0.1} label={{ value: bucket.coverage === 'open' ? 'In progress' : 'Partial start', fill: 'var(--ink-muted)', fontSize: 9.5 }} />
      ))}
      {collection >= metrics.startMs && collection <= metrics.endMs && <ReferenceLine x={collection} stroke="var(--ink-muted)" strokeDasharray="3 4" label={{ value: `Collection began ${timeTick(collection)}`, fill: 'var(--ink-muted)', fontSize: 9.5, position: 'insideTopLeft' }} />}
    </>
  )
}

export const RequestsChart = memo(({ metrics, title = 'Requests over time' }: { metrics: DashboardMetrics, title?: string }) => {
  const rows = buildTimeSeries(metrics)
  const uid = useId().replace(ID_SAFE, '')
  return (
    <ChartFrame
      title={title}
      summary={metricSummary(metrics, 'requests')}
      collectionStartedAt={metrics.collectionStartedAt}
      caption={`${title} numeric data`}
      rows={rows}
      rowKey={row => row.key}
      columns={[
        ...timeColumns,
        { key: 'completed', header: 'Completed', render: row => count(row.completed), numeric: true },
        { key: 'failed', header: 'Failed', render: row => count(row.failed), numeric: true },
        { key: 'aborted', header: 'Aborted', render: row => count(row.aborted), numeric: true },
        { key: 'total', header: 'Total', render: row => count(row.total), numeric: true },
      ]}
    >
      <ChartSurface key={`${metrics.window}:${metrics.collectionStartedAt}`} title={title} rows={rows} describe={row => `${interval(row)}. ${row.coverage}: ${count(row.completed)} completed, ${count(row.failed)} failed, ${count(row.aborted)} aborted.`}>
        {select => (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <BarChart
              data={rows}
              accessibilityLayer={false}
              barCategoryGap="24%"
              margin={{ top: 10, right: 8, bottom: 0, left: 0 }}
              onMouseMove={(state) => {
                if (state.activeTooltipIndex != null)
                  select(Number(state.activeTooltipIndex))
              }}
            >
              <defs>
                <linearGradient id={`${uid}-completed`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.65} />
                </linearGradient>
                <linearGradient id={`${uid}-failed`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--failed)" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="var(--failed)" stopOpacity={0.7} />
                </linearGradient>
                <linearGradient id={`${uid}-aborted`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--aborted)" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="var(--aborted)" stopOpacity={0.65} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="startMs" type="number" scale="time" domain={[metrics.startMs, metrics.endMs]} allowDataOverflow tickFormatter={timeTick} tick={tick} axisLine={axisLine} tickLine={tickLine} minTickGap={28} />
              <YAxis allowDecimals={false} tick={tick} width={38} axisLine={axisLine} tickLine={tickLine} />
              <CoverageMarks metrics={metrics} patternId={`${uid}-gap`} />
              <Bar dataKey="completed" name="Completed" stackId="terminal" fill={`url(#${uid}-completed)`} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="failed" name="Failed" stackId="terminal" fill={`url(#${uid}-failed)`} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="aborted" name="Aborted" stackId="terminal" fill={`url(#${uid}-aborted)`} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartSurface>
      <p className="monitor-legend">
        <span className="tone-completed">Completed</span>
        <span className="tone-failed">Failed</span>
        <span className="tone-aborted">Aborted</span>
      </p>
      <TimeCoverage metrics={metrics} />
    </ChartFrame>
  )
})

export const LatencyChart = memo(({ metrics, title = 'Latency over time' }: { metrics: DashboardMetrics, title?: string }) => {
  const rows = buildTimeSeries(metrics)
  const uid = useId().replace(ID_SAFE, '')
  return (
    <ChartFrame
      title={title}
      summary={metricSummary(metrics, 'latency')}
      collectionStartedAt={metrics.collectionStartedAt}
      caption={`${title} numeric data`}
      rows={rows}
      rowKey={row => row.key}
      columns={[
        ...timeColumns,
        { key: 'p50', header: 'p50', render: row => row.p50Label, numeric: true },
        { key: 'p95', header: 'p95', render: row => row.p95Label, numeric: true },
        { key: 'observed', header: 'Observed completed-request samples', render: row => count(row.observed), numeric: true },
      ]}
    >
      <ChartSurface key={`${metrics.window}:${metrics.collectionStartedAt}`} title={title} rows={rows} describe={row => `${interval(row)}. ${row.coverage}: p50 ${row.p50Label}, p95 ${row.p95Label}; ${count(row.observed)} observed completed-request samples.`}>
        {select => (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <LineChart
              data={rows}
              accessibilityLayer={false}
              margin={{ top: 10, right: 8, bottom: 0, left: 0 }}
              onMouseMove={(state) => {
                if (state.activeTooltipIndex != null)
                  select(Number(state.activeTooltipIndex))
              }}
            >
              <defs>
                <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="startMs" type="number" scale="time" domain={[metrics.startMs, metrics.endMs]} allowDataOverflow tickFormatter={timeTick} tick={tick} axisLine={axisLine} tickLine={tickLine} minTickGap={28} />
              <YAxis tick={tick} tickFormatter={formatDuration} width={62} axisLine={axisLine} tickLine={tickLine} />
              <CoverageMarks metrics={metrics} patternId={`${uid}-gap`} />
              <Area type="monotone" dataKey="p50" stroke="none" fill={`url(#${uid}-area)`} connectNulls={false} isAnimationActive={false} />
              <Line dataKey="p50" name="p50" stroke="var(--series-1)" strokeWidth={2.2} dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />
              <Line dataKey="p95" name="p95" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartSurface>
      <p className="monitor-legend">
        <span className="legend-series-1">p50 · solid</span>
        <span className="legend-series-2">p95 · dashed</span>
      </p>
      <p className="muted">Only completed-request samples contribute latency; failed and aborted requests do not. Empty intervals have gaps, not zero latency. Quantile quality is retained in the numeric data and selected values.</p>
      <TimeCoverage metrics={metrics} />
    </ChartFrame>
  )
})

export const HistogramChart = memo(({ metrics }: { metrics: DashboardMetrics }) => {
  const title = 'Latency distribution'
  const rows = buildHistogram(metrics)
  const peak = rows.reduce((max, row) => Math.max(max, row.count), 0)
  const uid = useId().replace(ID_SAFE, '')
  return (
    <ChartFrame
      title={title}
      summary={`${metrics.window} window: ${formatInteger(metrics.latency.count)} observed completed-request samples; latest interval ${rows.at(-1)?.label ?? 'none'} has ${formatInteger(rows.at(-1)?.count ?? 0)} samples; peak interval ${formatInteger(peak)} samples. Collection began ${formatDateTime(metrics.collectionStartedAt)}.`}
      collectionStartedAt={metrics.collectionStartedAt}
      caption="Latency distribution numeric data"
      rows={rows}
      rowKey={row => row.key}
      columns={[
        { key: 'interval', header: 'Latency interval', render: row => row.label },
        { key: 'count', header: 'Observed completed-request samples', render: row => formatInteger(row.count), numeric: true },
      ]}
    >
      <ChartSurface key={`${metrics.window}:${metrics.collectionStartedAt}`} title={title} rows={rows} describe={row => `${row.label}: ${formatInteger(row.count)} observed completed-request samples.`}>
        {select => (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <BarChart
              data={rows}
              accessibilityLayer={false}
              barCategoryGap="18%"
              margin={{ top: 10, right: 8, bottom: 0, left: 0 }}
              onMouseMove={(state) => {
                if (state.activeTooltipIndex != null)
                  select(Number(state.activeTooltipIndex))
              }}
            >
              <defs>
                <linearGradient id={`${uid}-hist`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-2)" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" tick={tick} interval="preserveStartEnd" axisLine={axisLine} tickLine={tickLine} />
              <YAxis allowDecimals={false} tick={tick} width={38} axisLine={axisLine} tickLine={tickLine} />
              <Bar dataKey="count" fill={`url(#${uid}-hist)`} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartSurface>
      <p className="muted">Adjacent intervals are re-binned from the merged window histogram; no completed-request samples are discarded. Failed and aborted requests do not contribute latency samples. The final interval includes overflow. This is a sample count, not a density.</p>
    </ChartFrame>
  )
})

export const BreakdownChart = memo(({ metrics, source, title }: { metrics: DashboardMetrics, source: readonly DashboardBreakdown[], title: string }) => {
  const rows = buildBreakdown(source)
  const requests = rows.reduce((sum, row) => sum + row.requests, 0)
  const failures = rows.reduce((sum, row) => sum + row.failures, 0)
  const peak = rows.reduce((max, row) => Math.max(max, row.requests), 0)
  return (
    <ChartFrame
      title={title}
      summary={`${metrics.window} window: ${formatInteger(requests)} requests, ${formatInteger(failures)} failures. Latest displayed dimension ${rows.at(-1)?.label ?? 'none'}; peak dimension ${formatInteger(peak)} requests. Collection began ${formatDateTime(metrics.collectionStartedAt)}.`}
      collectionStartedAt={metrics.collectionStartedAt}
      caption={`${title} numeric data`}
      rows={rows}
      rowKey={row => row.key}
      columns={[
        { key: 'dimension', header: 'Dimension', render: row => row.label },
        { key: 'requests', header: 'Requests', render: row => formatInteger(row.requests), numeric: true },
        { key: 'failures', header: 'Failures', render: row => formatInteger(row.failures), numeric: true },
      ]}
    >
      <ChartSurface key={`${metrics.window}:${metrics.collectionStartedAt}`} title={title} rows={rows} describe={row => `${row.label}: ${formatInteger(row.requests)} requests, ${formatInteger(row.failures)} failures.`}>
        {select => (
          <ResponsiveContainer width="100%" height={Math.max(190, rows.length * 40 + 30)} minWidth={0}>
            <BarChart
              layout="vertical"
              data={rows}
              accessibilityLayer={false}
              barGap={2}
              barCategoryGap="26%"
              margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
              onMouseMove={(state) => {
                if (state.activeTooltipIndex != null)
                  select(Number(state.activeTooltipIndex))
              }}
            >
              <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={tick} axisLine={axisLine} tickLine={tickLine} />
              <YAxis type="category" dataKey="label" width={118} tick={tick} axisLine={axisLine} tickLine={tickLine} />
              <Bar dataKey="requests" name="Requests" fill="var(--series-1)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
              <Bar dataKey="failures" name="Failures" fill="var(--failed)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartSurface>
      <p className="muted">Requests are blue; failures are red. Top eight dimensions by requests; Other (folded) is last and distinct from a literal name “other”.</p>
    </ChartFrame>
  )
})
