import type { DashboardUrlState } from './url-state'

import { redirectUrl } from './url-state'

export interface HostnameNavigation {
  assign: (url: string) => void
  hostname: string
  location: Pick<Location, 'protocol' | 'port'>
  state: DashboardUrlState
  stop: () => Promise<void>
}

export async function navigateToHostname({ assign, hostname, location, state, stop }: HostnameNavigation): Promise<void> {
  await stop()
  assign(redirectUrl(location, hostname, state))
}
