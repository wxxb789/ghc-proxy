import consola from 'consola'

import { CopilotClient, getVSCodeVersion } from '~/clients'

import { getClientConfig } from './client-config'
import { state } from './state'

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export async function cacheModels(client?: CopilotClient): Promise<void> {
  const copilotClient
    = client ?? new CopilotClient(state.auth, getClientConfig(state))

  const models = await copilotClient.getModels()

  state.cache.models = models
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.cache.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
