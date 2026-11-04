import type { DashboardMetrics, DashboardTarget } from '@contract'
import { useDashboardUrl } from '../../app/context'
import { LatencyChart, RequestsChart } from '../../components/charts'
import { Region, StatusChip } from '../../components/primitives'
import { formatDateTime, formatDuration, formatInteger, formatNumber, formatPercent, formatQuantile } from '../../lib/format'
import { useMetrics, useRequests, useTargetQuota, useTargets } from '../../lib/queries'
import { windowKpis } from '../../lib/series'
import { RecentFailures } from '../requests/recent-failures'

const requestRate = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 })

function TargetHealth({ target }: { target: DashboardTarget }) {
  const quota = useTargetQuota(target)
  return (
    <article className="monitor-target" aria-label={`${target.name} health`}>
      <div className="section-heading">
        <h3>{target.name}</h3>
        <StatusChip state={target.health.status} />
      </div>
      <dl className="monitor-facts">
        <div>
          <dt>Target type</dt>
          <dd>{target.kind === 'm365' ? 'Microsoft 365' : 'GitHub Copilot'}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>{target.identity ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>GitHub authentication</dt>
          <dd><StatusChip state={target.health.github.status} /></dd>
        </div>
        <div>
          <dt>{target.kind === 'm365' ? 'M365 authentication' : 'Copilot authentication'}</dt>
          <dd><StatusChip state={target.health.copilot.status} /></dd>
        </div>
        <div>
          <dt>Authentication expires</dt>
          <dd>{formatDateTime(target.health.copilot.expiresAt)}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>{target.health.copilot.modelsLoaded ? 'Loaded' : 'Not loaded'}</dd>
        </div>
        <div>
          <dt>Queue slots</dt>
          <dd>
            {formatInteger(target.queue.active)}
            {' '}
            /
            {' '}
            {formatInteger(target.queue.concurrency)}
          </dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd>
            {formatInteger(target.queue.pending)}
            {' '}
            /
            {' '}
            {formatInteger(target.queue.maxPending)}
          </dd>
        </div>
        <div>
          <dt>Account cooldown</dt>
          <dd>{target.queue.accountCooldown ? 'Cooling down' : 'Ready'}</dd>
        </div>
        <div>
          <dt>Model cooldowns</dt>
          <dd>{formatInteger(target.queue.modelCooldowns)}</dd>
        </div>
      </dl>
      <Region title={`${target.name} quota`} result={quota.region} retry={() => { void quota.refetch() }} unavailable={target.kind === 'm365' ? 'Quota is not applicable to this Microsoft 365 target.' : 'Quota is not available for this target.'}>
        {({ quota: data }) => (
          <div className="stack">
            {data.plan && <p>{data.plan}</p>}
            {data.resetDate && (
              <p className="muted">{`Resets ${formatDateTime(data.resetDate)}`}</p>
            )}
            <dl className="monitor-facts">
              {([['Chat', data.chat], ['Completions', data.completions], ['Premium interactions', data.premiumInteractions]] as const).map(([label, detail]) => detail && (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {detail.unlimited ? 'Unlimited' : `${formatInteger(detail.remaining)} / ${formatInteger(detail.entitlement)} remaining (${formatNumber(detail.percentRemaining)}%)`}
                    {detail.overagePermitted ? ' · overage permitted' : ''}
                  </dd>
                </div>
              ))}
            </dl>
            {!data.chat && !data.completions && !data.premiumInteractions && <p className="muted">No quota counters reported.</p>}
          </div>
        )}
      </Region>
    </article>
  )
}

function WindowKpis({ metrics }: { metrics: DashboardMetrics }) {
  const kpis = windowKpis(metrics)
  return (
    <>
      <p className="muted monitor-detail-title">
        {metrics.window}
        {' '}
        window ·
        {' '}
        {formatDuration(metrics.coveredMs)}
        {' '}
        covered. Health and active queue state are current.
      </p>
      <dl className="monitor-kpis">
        <div>
          <dt>Terminal requests</dt>
          <dd aria-label="Terminal requests">{metrics.coveredMs > 0 ? formatInteger(kpis.requests) : 'Not collected'}</dd>
          <small>{metrics.coveredMs > 0 ? `${metrics.counts.completed} completed · ${metrics.counts.failed} failed · ${metrics.counts.aborted} aborted` : 'No covered interval yet'}</small>
        </div>
        <div>
          <dt>Request rate</dt>
          <dd aria-label="Request rate">{kpis.rate === null ? '—' : `${requestRate.format(kpis.rate)} /s`}</dd>
          <small>Terminal requests / covered time</small>
        </div>
        <div>
          <dt>Error rate</dt>
          <dd aria-label="Error rate">{formatPercent(kpis.errorRate)}</dd>
          <small>Failed / (completed + failed); aborted excluded</small>
        </div>
        <div>
          <dt>p95 latency</dt>
          <dd aria-label="p95 latency">{formatQuantile(kpis.p95)}</dd>
          <small>
            {formatInteger(metrics.latency.count)}
            {' '}
            observed completed-request samples · merged window distribution
          </small>
        </div>
      </dl>
      {metrics.coveredMs === 0
        ? <p className="muted">No collected time in this window. Uncollected time is unknown, not zero traffic.</p>
        : kpis.requests === 0 && <p className="muted">No traffic yet in this window. Time before collection began is not zero traffic.</p>}
    </>
  )
}

export function OverviewPage() {
  const { url } = useDashboardUrl()
  const metrics = useMetrics(url.window, url.target)
  const targets = useTargets()
  const requests = useRequests()
  const selectedTargets = targets.data?.targets.filter(target => url.target === undefined || target.name === url.target) ?? []
  const active = requests.data?.active.filter(request => url.target === undefined || request.accountName === url.target)
  return (
    <>
      <div className="monitor-summary">
        <Region title="Window health and performance" result={{ ...metrics.region, state: metrics.region.state === 'empty' ? 'ready' : metrics.region.state }} retry={() => { void metrics.refetch() }}>
          {data => <WindowKpis metrics={data} />}
        </Region>
        <Region title="Active request activity" result={{ ...requests.region, state: requests.region.state === 'empty' ? 'ready' : requests.region.state }} retry={() => { void requests.refetch() }}>
          {() => (
            <dl className="monitor-kpis">
              <div>
                <dt>Active requests</dt>
                <dd aria-label="Active requests">{formatInteger(active?.length)}</dd>
                <small>{`Includes ${formatInteger(active?.filter(request => request.state === 'streaming').length)} streaming`}</small>
              </div>
            </dl>
          )}
        </Region>
        <Region title="Selected-target queue" result={targets.region} retry={() => { void targets.refetch() }}>
          {() => (
            <dl className="monitor-kpis">
              <div>
                <dt>Health</dt>
                <dd aria-label="Selected-target health"><StatusChip state={selectedTargets.length === 0 ? 'unavailable' : selectedTargets.some(target => target.health.status === 'degraded') ? 'degraded' : 'ok'} /></dd>
              </div>
              <div>
                <dt>Queue slots</dt>
                <dd aria-label="Queue slots">
                  {formatInteger(selectedTargets.reduce((sum, target) => sum + target.queue.active, 0))}
                  {' '}
                  /
                  {' '}
                  {formatInteger(selectedTargets.reduce((sum, target) => sum + target.queue.concurrency, 0))}
                </dd>
              </div>
              <div>
                <dt>Pending requests</dt>
                <dd aria-label="Pending requests">{formatInteger(selectedTargets.reduce((sum, target) => sum + target.queue.pending, 0))}</dd>
              </div>
            </dl>
          )}
        </Region>
      </div>
      <Region title="Window trends" result={{ ...metrics.region, state: metrics.region.state === 'empty' ? 'ready' : metrics.region.state }} retry={() => { void metrics.refetch() }}>
        {data => (
          <div className="monitor-chart-grid">
            <RequestsChart key={`requests:${data.startedAt}:${url.target ?? ''}`} metrics={data} />
            <LatencyChart key={`latency:${data.startedAt}:${url.target ?? ''}`} metrics={data} />
          </div>
        )}
      </Region>
      <Region title="Target health" result={targets.region} retry={() => { void targets.refetch() }} empty="No targets are configured.">
        {() => <div className="grid-cards">{selectedTargets.map(target => <TargetHealth key={target.runtimeId} target={target} />)}</div>}
      </Region>
      <Region title="Recent failures" result={{ ...metrics.region, state: metrics.region.state === 'empty' ? 'ready' : metrics.region.state }} retry={() => { void metrics.refetch() }}>
        {data => <RecentFailures metrics={data} requests={requests} />}
      </Region>
    </>
  )
}
