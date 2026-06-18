/**
 * Compile-time exhaustiveness check for switch/if-else chains on
 * discriminated unions.  At runtime, throws with a descriptive message.
 */
export function assertNever(value: never, context?: string): never {
  const label = context ?? 'Unexpected value'
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
