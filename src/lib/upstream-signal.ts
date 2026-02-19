const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

export function createUpstreamSignal(clientSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const onAbort = () => controller.abort()
  if (clientSignal && !clientSignal.aborted) {
    clientSignal.addEventListener('abort', onAbort)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      clientSignal?.removeEventListener('abort', onAbort)
    },
  }
}
