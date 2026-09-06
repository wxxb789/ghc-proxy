export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
