interface UpstreamSignalOptions {
  clientSignal?: AbortSignal
  timeoutMs?: number
}

interface UpstreamSignalResult {
  signal: AbortSignal
  cleanup: () => void
}

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

export function createUpstreamSignal(
  options?: UpstreamSignalOptions,
): UpstreamSignalResult {
  const { clientSignal, timeoutMs = DEFAULT_TIMEOUT_MS } = options ?? {}

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  let listenerAdded = false
  let abortListener: (() => void) | undefined

  // Only add listener if clientSignal exists and is not already aborted
  if (clientSignal && !clientSignal.aborted) {
    abortListener = () => {
      controller.abort()
    }
    clientSignal.addEventListener('abort', abortListener)
    listenerAdded = true
  }

  const cleanup = () => {
    clearTimeout(timeout)

    if (listenerAdded && clientSignal && abortListener) {
      clientSignal.removeEventListener('abort', abortListener)
    }
  }

  return {
    signal: controller.signal,
    cleanup,
  }
}
