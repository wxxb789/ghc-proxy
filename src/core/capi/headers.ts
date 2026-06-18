/**
 * Leaf helper for reading optional request headers. Lives in its own module so
 * both request-context.ts and subagent-marker.ts can depend on it without
 * importing each other (which would form a cycle).
 */
export function readHeader(
  headers: Headers,
  name: string,
): string | undefined {
  return headers.get(name) ?? undefined
}
