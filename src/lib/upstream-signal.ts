import { authStore } from '~/state'
import { errorCauseChainSome } from './timeout-error'

const DEFAULT_TIMEOUT_MS = 1_800_000 // 30 minutes

const CLIENT_ABORT_MARKER = 'ghcProxyClientAbort'

class ClientAbortError extends DOMException {
  readonly [CLIENT_ABORT_MARKER] = true

  constructor() {
    super('The client aborted the request.', 'AbortError')
  }
}

export function isClientAbortError(error: unknown): boolean {
  return errorCauseChainSome(
    error,
    candidate => (candidate as Record<string, unknown>)[CLIENT_ABORT_MARKER] === true,
  )
}

export function createUpstreamDeadlineFromConfig(
  now = performance.now(),
): number | null {
  const timeoutMs = authStore.upstreamTimeoutSeconds !== undefined
    ? authStore.upstreamTimeoutSeconds * 1000
    : DEFAULT_TIMEOUT_MS
  return timeoutMs > 0 ? now + timeoutMs : null
}

export function createUpstreamSignal(
  clientSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onClientAbort?: () => void,
) {
  const controller = new AbortController()
  // No abort reason on purpose: a bare `abort()` yields the standard
  // DOMException `AbortError`, which `isTimeoutLikeError` recognizes. A custom
  // reason would replace it and silently break the 504 mapping.
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined

  const onAbort = () => {
    onClientAbort?.()
    controller.abort(new ClientAbortError())
  }
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
export function createUpstreamSignalFromConfig(
  clientSignal: AbortSignal,
  deadlineMonotonicMs = createUpstreamDeadlineFromConfig(),
  onClientAbort?: () => void,
) {
  const remainingMs = deadlineMonotonicMs === null
    ? undefined
    : deadlineMonotonicMs - performance.now()
  const upstreamSignal = remainingMs !== undefined && remainingMs <= 0
    ? createExpiredUpstreamSignal(clientSignal, onClientAbort)
    : createUpstreamSignal(clientSignal, remainingMs ?? 0, onClientAbort)
  return { ...upstreamSignal, deadlineMonotonicMs }
}

function createExpiredUpstreamSignal(
  clientSignal: AbortSignal,
  onClientAbort?: () => void,
) {
  const controller = new AbortController()
  controller.abort()
  const onAbort = () => onClientAbort?.()
  if (!clientSignal.aborted)
    clientSignal.addEventListener('abort', onAbort)
  return {
    signal: controller.signal,
    clientSignal,
    cleanup: () => clientSignal.removeEventListener('abort', onAbort),
  }
}
