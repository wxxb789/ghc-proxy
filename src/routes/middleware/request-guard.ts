import { awaitApproval } from '~/lib/approval'
import { checkRateLimit } from '~/lib/rate-limit'
import { state } from '~/lib/state'

/**
 * Framework-agnostic request guard logic.
 * Checks rate limits and optionally awaits manual approval.
 */
export async function runRequestGuard(): Promise<void> {
  await checkRateLimit(state)

  if (state.config.manualApprove) {
    await awaitApproval()
  }
}
