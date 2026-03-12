import type { SSEOutput } from '~/lib/execution-strategy'

import { sse } from 'elysia'

/**
 * Bridges an AsyncGenerator<SSEOutput> to Elysia's SSE response format.
 * Returns an async generator that yields sse() calls for each SSE output item.
 */
export async function* sseAdapter(generator: AsyncGenerator<SSEOutput>) {
  for await (const output of generator) {
    yield sse({
      id: output.id,
      event: output.event,
      data: output.data,
    })
  }
}
