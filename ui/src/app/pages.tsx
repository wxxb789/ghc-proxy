import type { DashboardPage, DashboardWindowId } from '@contract'
import type { ComponentType } from 'react'
import { useId } from 'react'
import { BehaviorPage } from '../pages/behavior'
import { ModelsPage } from '../pages/models'
import { OverviewPage } from '../pages/overview'
import { RequestsPage } from '../pages/requests'
import { TargetsPage } from '../pages/targets'
import { TrafficPage } from '../pages/traffic'
import { useDashboardUrl } from './context'
import { Shell } from './shell'

const PAGES: Record<DashboardPage, ComponentType> = {
  overview: OverviewPage,
  traffic: TrafficPage,
  requests: RequestsPage,
  targets: TargetsPage,
  models: ModelsPage,
  behavior: BehaviorPage,
}
const DESCRIPTIONS: Record<DashboardPage, string> = {
  overview: 'Live activity and recent signals from this proxy session.',
  traffic: 'Explore request volume, latency, and where failures are happening.',
  requests: 'Inspect active work and the most recent 256 terminal requests. Request content is never stored.',
  targets: 'Connect and manage the route targets available to this proxy.',
  models: 'Explore model capabilities and the routes available on this host.',
  behavior: 'See the routing and compatibility rules running in this process.',
}

function WindowControl() {
  const { url, navigate } = useDashboardUrl()
  const id = useId()
  return (
    <div className="inline-controls">
      <label htmlFor={id}>Metric window</label>
      <select id={id} value={url.window} onChange={event => navigate({ window: event.target.value as DashboardWindowId })}>
        <option value="15m">15 minutes</option>
        <option value="1h">1 hour</option>
        <option value="24h">24 hours</option>
      </select>
    </div>
  )
}

export function DashboardPages() {
  const { url } = useDashboardUrl()
  const Page = url.page ? PAGES[url.page] : undefined
  const hasWindow = url.page === 'overview' || url.page === 'traffic' || url.page === 'behavior'
  return (
    <Shell description={url.page ? DESCRIPTIONS[url.page] : undefined} actions={hasWindow ? <WindowControl /> : undefined}>
      {Page && <Page />}
    </Shell>
  )
}
