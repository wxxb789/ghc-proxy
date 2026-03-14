import type { AppState } from './state'

import consola from 'consola'

import { HTTPError } from './error'
import { sleep } from './sleep'

export async function checkRateLimit(state: AppState) {
  if (state.config.rateLimitSeconds === undefined)
    return

  const now = Date.now()
  const intervalMs = state.config.rateLimitSeconds * 1000

  // First request or interval already passed — claim slot synchronously
  if (!state.rateLimit.nextAvailableAt || now >= state.rateLimit.nextAvailableAt) {
    state.rateLimit.nextAvailableAt = now + intervalMs
    return
  }

  // Slot is occupied — need to wait or reject
  const waitMs = state.rateLimit.nextAvailableAt - now
  const waitTimeSeconds = Math.ceil(waitMs / 1000)

  if (!state.config.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(429, {
      error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
    })
  }

  // Claim the NEXT slot synchronously BEFORE awaiting, preventing TOCTOU race
  const claimedSlot = state.rateLimit.nextAvailableAt
  state.rateLimit.nextAvailableAt = claimedSlot + intervalMs

  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitMs)

  consola.info('Rate limit wait completed, proceeding with request')
}
