import type { EmbeddedUi } from './embedded-ui'
import type { DashboardMetadataRefreshService } from './metadata-refresh'
import type { DashboardQuotaCache } from './quota'
import type {
  AccountAuthenticationSession,
  AccountManagementSnapshot,
  AddAccountInput,
} from '~/accounts/manager'

export interface DashboardAccountManagement {
  beginAddAccount: (input: AddAccountInput) => Promise<AccountAuthenticationSession>
  bootstrapAccountRouting: (hostname: string) => Promise<void>
  configureM365Target: (
    input: { account?: string | null, hostname?: string },
  ) => Promise<void>
  getAuthenticationSession: (id: string) => AccountAuthenticationSession | undefined
  getMscAuthExe?: () => string | undefined
  getAccountSnapshot: () => AccountManagementSnapshot
  registerM365Target: (
    input: { account?: string | null, hostname?: string },
  ) => Promise<void>
  removeM365Target: () => Promise<void>
  removeAccount: (accountName: string) => Promise<void>
  setDefaultAccount: (accountName: string) => Promise<void>
}

export interface DashboardRouteOptions {
  accountManager?: DashboardAccountManagement
  metadataRefresher?: DashboardMetadataRefreshService
  quotaCache?: DashboardQuotaCache
  serverPort?: number
  ui?: EmbeddedUi | null
}
