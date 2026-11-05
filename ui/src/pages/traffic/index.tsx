import { useDashboardUrl } from '../../app/context'
import { BreakdownChart, HistogramChart, LatencyChart, RequestsChart } from '../../components/charts'
import { Region } from '../../components/primitives'
import { useMetrics, useRequests } from '../../lib/queries'
import { windowKpis } from '../../lib/series'
import { RecentFailures } from '../requests/recent-failures'

export function TrafficPage() {
  const { url } = useDashboardUrl()
  const metrics = useMetrics(url.window, url.target)
  const requests = useRequests()
  const result = { ...metrics.region, state: metrics.region.state === 'empty' ? 'ready' as const : metrics.region.state }
  return (
    <div className="traffic-page">
      <Region title="Terminal traffic" result={result} retry={() => { void metrics.refetch() }}>
        {data => (
          <>
            {data.coveredMs === 0
              ? <p className="muted monitor-detail-title">No collected time in this window. Uncollected time is unknown, not zero traffic.</p>
              : windowKpis(data).requests === 0 && <p className="muted monitor-detail-title">No traffic yet in this window. Uncollected time is not zero traffic.</p>}
            <RequestsChart key={`${data.startedAt}:${url.target ?? ''}`} metrics={data} />
          </>
        )}
      </Region>
      <div className="traffic-duo">
        <Region title="Latency" result={result} retry={() => { void metrics.refetch() }}>
          {data => <LatencyChart key={`${data.startedAt}:${url.target ?? ''}`} metrics={data} />}
        </Region>
        <Region title="Distribution" result={result} retry={() => { void metrics.refetch() }}>
          {data => <HistogramChart key={`${data.startedAt}:${url.target ?? ''}`} metrics={data} />}
        </Region>
      </div>
      <Region title="Window breakdowns" result={result} retry={() => { void metrics.refetch() }}>
        {data => (
          <div className="monitor-chart-grid" key={`${data.startedAt}:${url.target ?? ''}`}>
            <BreakdownChart metrics={data} source={data.byModel} title="Requests and failures by model" />
            <BreakdownChart metrics={data} source={data.byTarget} title="Requests and failures by target" />
            <BreakdownChart metrics={data} source={data.byEndpoint} title="Requests and failures by endpoint" />
          </div>
        )}
      </Region>
      <Region title="Recent failures" result={result} retry={() => { void metrics.refetch() }}>
        {data => <RecentFailures metrics={data} requests={requests} />}
      </Region>
    </div>
  )
}
