/**
 * Whether an error represents a request that timed out or was aborted.
 *
 * The shape differs by runtime, so the check is structural rather than a
 * single `name` comparison:
 * - Bun rejects with a flat `DOMException` named `TimeoutError` (its ~300s
 *   `fetch` ceiling, `AbortSignal.timeout`) or `AbortError`.
 * - Node rejects with `TypeError('fetch failed' | 'terminated')` and puts the
 *   real undici error on `.cause` (`HeadersTimeoutError`, `BodyTimeoutError`,
 *   `ConnectTimeoutError`), so the top-level error carries no signal at all —
 *   `TypeError('fetch failed')` is also what `ECONNREFUSED` and DNS failures
 *   look like. The discriminator is the cause's `name`/`code`.
 *
 * Both runtimes enforce a ~300s upstream ceiling by default (Node's is
 * undici's `headersTimeout`/`bodyTimeout` default of `300e3`). It is an
 * **idle** timer on both, not a total-duration cap: it resets on every byte, so
 * it fires on a stalled stream well before the configured `--upstream-timeout`
 * of 1800s, and never on one that keeps streaming. See
 * `docs/design/streaming.md`.
 *
 * Kept in one place because the rule is checked on both sides of the stream
 * boundary: `src/server.ts` maps it to a 504 before the first byte, and the
 * Anthropic stream transducer maps it to an SSE error frame after. Two
 * implementations of "what counts as a timeout" is how one of them ends up
 * recognizing only half the errors.
 */

const TIMEOUT_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
])

// Node-only string codes. `DOMException.code` is a *number* (23/20), so it is
// never compared here — the name check above already covers those.
//
// `ETIMEDOUT` is the one entry that carries real weight: on a dual-stack
// connect the timed-out leg is a plain `Error` whose only signal is its code.
// The three `UND_ERR_*` are redundant with their names on undici >= 7, which
// always sets both; they are kept as a cheap fallback in case a wrapper ever
// strips `name`.
const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
])

// Deepest shape observed in the wild is 2: `TypeError` -> `AggregateError` ->
// an `ETIMEDOUT` leaf, when a dual-stack connect's refused leg loses the race
// first and takes the aggregate's own `code`. The bound keeps a margin over
// that and, together with the try/catch below, stops a self-referential
// `cause` from looping forever.
const MAX_CAUSE_DEPTH = 5

function matchesTimeoutShape(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null)
    return false

  const candidate = value as { name?: unknown, code?: unknown, cause?: unknown, errors?: unknown }
  if (typeof candidate.name === 'string' && TIMEOUT_ERROR_NAMES.has(candidate.name))
    return true
  if (typeof candidate.code === 'string' && TIMEOUT_ERROR_CODES.has(candidate.code))
    return true

  if (depth >= MAX_CAUSE_DEPTH)
    return false
  if (matchesTimeoutShape(candidate.cause, depth + 1))
    return true
  // `.errors` too, not just `.cause`: a dual-stack connect failure buries the
  // ETIMEDOUT leaf in an AggregateError under the TypeError.
  return Array.isArray(candidate.errors)
    && candidate.errors.some(inner => matchesTimeoutShape(inner, depth + 1))
}

export function isTimeoutLikeError(error: unknown): boolean {
  // A `cause` getter that throws must not turn a predicate into a throw site.
  try {
    return matchesTimeoutShape(error, 0)
  }
  catch {
    return false
  }
}
