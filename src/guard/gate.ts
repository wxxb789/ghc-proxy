import { awaitApproval } from '~/lib/approval'
import { authStore, rateLimiter } from '~/state'

export async function runGuard(): Promise<void> {
  await rateLimiter.acquire(authStore.rateLimitSeconds, authStore.rateLimitWait)
  if (authStore.manualApprove) {
    await awaitApproval()
  }
}
