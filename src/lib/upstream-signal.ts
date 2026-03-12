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
