import { authStore } from '~/state'

const DEFAULT_TIMEOUT_MS = 1_800_000 // 30 minutes

export function createUpstreamSignal(clientSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  // No abort reason on purpose: a bare `abort()` yields the standard
  // DOMException `AbortError`, which `isTimeoutLikeError` recognizes. A custom
  // reason would replace it and silently break the 504 mapping.
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
 * This signal is a *total-duration* limit. Both runtimes separately apply an
 * ~300s **idle** timeout to `fetch` — Bun's is built in, Node's is undici's
 * `headersTimeout` / `bodyTimeout` default of `300e3` — which resets on every
 * byte received. A response that keeps streaming therefore runs past 300s and
 * is bounded only by this signal; a stalled one is rejected at ~300s by the
 * runtime instead. `isTimeoutLikeError` recognizes both runtimes' shapes so
 * every path maps to a 504.
 */
export function createUpstreamSignalFromConfig(clientSignal: AbortSignal) {
  return createUpstreamSignal(
    clientSignal,
    authStore.upstreamTimeoutSeconds !== undefined
      ? authStore.upstreamTimeoutSeconds * 1000
      : undefined,
  )
}
