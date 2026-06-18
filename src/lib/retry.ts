import { sleep } from '~/util/sleep'

export interface RetryOptions {
  /** Maximum number of retries (not counting the initial attempt). Default: 4 */
  maxRetries?: number
  /** Base delay in milliseconds before the first retry. Default: 5000 */
  baseDelayMs?: number
  /** Predicate to decide whether an error is retryable. Defaults to always true. */
  shouldRetry?: (error: unknown) => boolean
  /** Called before each retry sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

/**
 * Retry an async operation with exponential backoff.
 * Delay schedule: baseDelayMs * 2^attempt (0-indexed), e.g. 5s, 10s, 20s, 40s.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 4
  const baseDelayMs = options?.baseDelayMs ?? 5_000
  const shouldRetry = options?.shouldRetry ?? (() => true)
  const onRetry = options?.onRetry

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      lastError = error

      if (!shouldRetry(error) || attempt >= maxRetries) {
        throw error
      }

      const delay = baseDelayMs * 2 ** attempt
      onRetry?.(error, attempt, delay)
      await sleep(delay)
    }
  }

  throw lastError
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
