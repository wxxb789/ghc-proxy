import type { DashboardMetrics } from '@contract'
import type { RequestsResult } from '../../lib/api'
import type { DashboardRead } from '../../lib/queries'
import { Link } from 'wouter'
import { useDashboardUrl } from '../../app/context'
import { DataTable, Region } from '../../components/primitives'
import { formatInteger } from '../../lib/format'
import { windowKpis } from '../../lib/series'
import { buildUrl } from '../../lib/url-state'

export function RecentFailures({ metrics, requests }: { metrics: DashboardMetrics, requests: DashboardRead<RequestsResult> }) {
  const { url } = useDashboardUrl()
  return (
    <>
      <p className="muted monitor-detail-title">
        {metrics.coveredMs > 0 ? `${formatInteger(metrics.counts.failed)} failures in the ${metrics.window} window.` : `Failure counts are not collected for the ${metrics.window} window yet.`}
        {' '}
        Showing up to eight retained failures; Requests keeps the last 256 terminal requests, so older failures may not be listed.
      </p>
      {metrics.coveredMs === 0
        ? <p>No collected time in this window. Failure counts are not yet available.</p>
        : windowKpis(metrics).requests === 0
          ? <p>No traffic yet in this window.</p>
          : metrics.counts.failed === 0
            ? <p>Zero failures in this window.</p>
            : (
                <Region title="Retained failure list" result={{ ...requests.region, state: requests.region.state === 'empty' ? 'ready' : requests.region.state }} retry={() => { void requests.refetch() }}>
                  {(data) => {
                    const failures = data.recent.filter((request) => {
                      const completedAt = Date.parse(request.startedAt) + request.durationMs
                      return request.state === 'failed' && request.endpoint !== '/' && request.endpoint !== '/health'
                        && (url.target === undefined || request.accountName === url.target)
                        && completedAt >= Math.max(metrics.startMs, Date.parse(metrics.collectionStartedAt)) && completedAt < metrics.endMs
                    }).slice().sort((left, right) => Date.parse(right.startedAt) + right.durationMs - Date.parse(left.startedAt) - left.durationMs).slice(0, 8)
                    return failures.length === 0
                      ? <p>No failures from this window are retained in the request list.</p>
                      : (
                          <DataTable
                            caption="Recent failed requests"
                            rows={failures}
                            rowKey={request => request.requestId}
                            columns={[
                              { key: 'id', header: 'Request', render: request => <Link href={buildUrl({ page: 'requests', window: url.window, target: url.target, request: request.requestId, state: 'failed' })}>{request.requestId}</Link> },
                              { key: 'target', header: 'Target', render: request => request.accountName ?? 'Not specified' },
                              { key: 'endpoint', header: 'Endpoint', render: request => request.endpoint },
                              { key: 'error', header: 'Error summary', render: request => request.errorSummary ?? `HTTP ${request.status ?? 'unknown'}` },
                            ]}
                          />
                        )
                  }}
                </Region>
              )}
      <p><Link href={buildUrl({ page: 'requests', window: url.window, target: url.target, state: 'failed' })}>View failed requests</Link></p>
    </>
  )
}
