import type { DashboardRouteOptions } from './types'
import type { DashboardOverview, DashboardRequests } from '~/types/dashboard'

import { getUpstreamRequestQueueSnapshot } from '~/clients/factory'
import { RECENT_REQUEST_LIMIT } from '~/observability/request-store'
import { runtimeStore } from '~/state'
import { VERSION } from '~/util/version'
import { getDashboardTargets } from './targets-projection'

export function getDashboardOverview(options: DashboardRouteOptions, request: Request): DashboardOverview {
  const requests = runtimeStore.requests.summary()
  const targets = getDashboardTargets(options, request)
  return {
    status: targets.targets.length > 0 && targets.targets.every(target => target.health.status === 'ok') ? 'ok' : 'degraded',
    version: VERSION,
    startedAt: runtimeStore.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(runtimeStore.startedAt)),
    hostTarget: targets.hostTarget,
    capabilities: targets.capabilities,
    activity: {
      activeRequests: requests.active,
      recentRequests: requests.recent,
      ...requests.totals,
      upstreamQueue: getUpstreamRequestQueueSnapshot(),
    },
  }
}

export function getDashboardRequests(): DashboardRequests {
  return { capacity: RECENT_REQUEST_LIMIT, ...runtimeStore.requests.snapshot() }
}
