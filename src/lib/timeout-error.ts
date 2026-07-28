/**
 * Whether an error represents a request that timed out or was aborted.
 *
 * Two distinct names reach here and both mean "the request did not complete":
 * - `AbortError` — an `AbortController` fired, either from the client
 *   disconnecting or from the proxy-side timeout in `~/lib/upstream-signal`.
 * - `TimeoutError` — a runtime-level deadline expired. Bun's `fetch` has a
 *   built-in ~300s ceiling that fires before the configured upstream timeout
 *   can, and it throws a `DOMException` named `TimeoutError`, not `AbortError`.
 *
 * Kept in one place because the rule is checked on both sides of the stream
 * boundary: `src/server.ts` maps it to a 504 before the first byte, and the
 * Anthropic stream transducer maps it to an SSE error frame after. Two
 * implementations of "what counts as a timeout" is how one of them ends up
 * recognizing only half the errors.
 */
export function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}
