import type { AccountAuthenticationSession as ServerAuthenticationSession, AccountRoutingSummary as ServerRoutingSummary } from '~/accounts/manager'
import type { MscAccount as ServerMscAccount } from '~/clients/msc-auth'
import type * as Contract from '~/routes/dashboard/contract'
import type {
  getDashboardAccount,
  getDashboardBehavior,
  getDashboardModels,
  getDashboardOverview,
  getDashboardRequests,
} from '~/routes/dashboard/handler'
import type { M365DashboardState, probeM365Readiness } from '~/routes/dashboard/m365'
import type { DashboardMetadataRefresh } from '~/routes/dashboard/metadata-refresh'

import { expect, test } from 'bun:test'
import { RECENT_REQUEST_LIMIT } from '~/observability/request-store'

/**
 * Compile-time drift check between the server's projections and the wire
 * contract the Dashboard UI consumes (`src/routes/dashboard/contract.ts`).
 * A server-side shape change that the UI contract does not describe fails
 * `bun run typecheck` here.
 */
type Assignable<From, To> = [From] extends [To] ? true : false
function expectAssignable<_T extends true>() {}

type Payload<T> = Omit<T, keyof Contract.DashboardEnvelope>

expectAssignable<Assignable<Awaited<ReturnType<typeof getDashboardOverview>>, Payload<Contract.OverviewResponse>>>()
expectAssignable<Assignable<ReturnType<typeof getDashboardModels>[number], Contract.DashboardModel>>()
expectAssignable<Assignable<ReturnType<typeof getDashboardBehavior>, Payload<Contract.BehaviorResponse>>>()
expectAssignable<Assignable<ReturnType<typeof getDashboardRequests> & { capacity: number }, Payload<Contract.RequestsResponse>>>()
expectAssignable<Assignable<Awaited<ReturnType<typeof getDashboardAccount>>, Contract.DashboardAccount>>()
expectAssignable<Assignable<M365DashboardState, Contract.M365DashboardState>>()
expectAssignable<Assignable<Awaited<ReturnType<typeof probeM365Readiness>>, Payload<Contract.M365ProbeResponse>>>()
expectAssignable<Assignable<DashboardMetadataRefresh, Payload<Contract.MetadataRefreshResponse>>>()
expectAssignable<Assignable<ServerAuthenticationSession, Contract.AccountAuthenticationSession>>()
expectAssignable<Assignable<ServerRoutingSummary, Contract.AccountRoutingSummary>>()
expectAssignable<Assignable<ServerMscAccount, Contract.MscAccount>>()

test('dashboard contract mirrors the request ring capacity', () => {
  const response: Pick<Contract.RequestsResponse, 'capacity'> = { capacity: RECENT_REQUEST_LIMIT }
  expect(response.capacity).toBe(256)
})
