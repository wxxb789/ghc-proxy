export const MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE = 20

export class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FunctionCallArgumentsValidationError'
  }
}

export function updateWhitespaceRunState(
  previousCount: number,
  chunk: string,
): { nextCount: number, exceeded: boolean } {
  let count = previousCount

  for (const char of chunk) {
    if (char === ' ' || char === '\r' || char === '\n' || char === '\t') {
      count += 1
      if (count > MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE) {
        return { nextCount: count, exceeded: true }
      }
      continue
    }
    count = 0
  }

  return { nextCount: count, exceeded: false }
}
