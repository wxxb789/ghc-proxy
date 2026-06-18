import consola from 'consola'
import { HTTPError } from '~/lib/error'
import { sleep } from '~/util/sleep'

export class RateLimiter {
  private nextAvailableAt = 0

  reset(): void {
    this.nextAvailableAt = 0
  }

  async acquire(intervalSeconds: number | undefined, waitMode: boolean): Promise<void> {
    if (intervalSeconds === undefined)
      return

    const now = Date.now()
    const intervalMs = intervalSeconds * 1000

    // First request or interval already passed — claim slot synchronously
    if (!this.nextAvailableAt || now >= this.nextAvailableAt) {
      this.nextAvailableAt = now + intervalMs
      return
    }

    // Slot is occupied — need to wait or reject
    const waitMs = this.nextAvailableAt - now
    const waitTimeSeconds = Math.ceil(waitMs / 1000)

    if (!waitMode) {
      consola.warn(
        `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
      )
      throw new HTTPError(429, {
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      })
    }

    // Claim the NEXT slot synchronously BEFORE awaiting, preventing TOCTOU race
    const claimedSlot = this.nextAvailableAt
    this.nextAvailableAt = claimedSlot + intervalMs

    consola.warn(
      `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
    )
    await sleep(waitMs)

    consola.info('Rate limit wait completed, proceeding with request')
  }
}

export const rateLimiter = new RateLimiter()
