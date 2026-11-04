import type { DashboardRouteOptions } from './types'

import { Elysia } from 'elysia'

import { resolveRequestPeer } from '~/lib/peer'
import { registerConfigRoutes } from './config'
import { rejectDashboardAccess } from './guard'
import { registerM365Routes } from './m365-routes'
import { registerMonitorRoutes } from './monitor'
import { registerServingRoutes } from './serving'
import { registerTargetRoutes } from './targets'

export function createDashboardRoutes(options: DashboardRouteOptions = {}) {
  const app = new Elysia({ name: 'dashboard' })

  app.onBeforeHandle(({ request, server }) => {
    const peer = resolveRequestPeer(request, server)
    return rejectDashboardAccess(request, peer.address, peer.live)
  })

  registerServingRoutes(app, options.ui)
  registerMonitorRoutes(app, options)
  registerConfigRoutes(app, options.serverPort)
  registerTargetRoutes(app, options)
  registerM365Routes(app, options)

  return app
}
