import type { AppState } from './state'

import type { ClientConfig } from '~/clients'

export function getClientConfig(appState: AppState): ClientConfig {
  return {
    accountType: appState.config.accountType,
    vsCodeVersion: appState.cache.vsCodeVersion,
  }
}
