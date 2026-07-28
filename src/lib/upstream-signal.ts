import { authStore } from '~/state'

const DEFAULT_TIMEOUT_MS = 1_800_000 // 30 minutes

export function createUpstreamSignal(clientSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined

  const onAbort = () => controller.abort()
  if (clientSignal && !clientSignal.aborted) {
    clientSignal.addEventListener('abort', onAbort)
  }

  return {
    signal: controller.signal,
    clientSignal,
    cleanup: () => {
      if (timeout)
        clearTimeout(timeout)
      clientSignal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Convenience wrapper that reads the upstream timeout from runtime config.
 *
 * Note: on Bun, `fetch` enforces its own ~300s ceiling (measured on Bun 1.3.14)
 * and rejects with a `TimeoutError` — passing a longer `AbortSignal` does not
 * raise it. Any configured timeout above that never fires on Bun; the runtime
 * aborts first. `isTimeoutLikeError` treats both names as timeouts so either
 * path maps to a 504.
 */
export function createUpstreamSignalFromConfig(clientSignal: AbortSignal) {
  return createUpstreamSignal(
    clientSignal,
    authStore.upstreamTimeoutSeconds !== undefined
      ? authStore.upstreamTimeoutSeconds * 1000
      : undefined,
  )
}
