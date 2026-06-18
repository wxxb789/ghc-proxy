import { authStore, rateLimiter } from '~/state'
import { awaitApproval } from './approval'

export async function runGuard(): Promise<void> {
  await rateLimiter.acquire(authStore.rateLimitSeconds, authStore.rateLimitWait)
  if (authStore.manualApprove) {
    await awaitApproval()
  }
}
