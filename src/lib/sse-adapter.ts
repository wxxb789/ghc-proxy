import type { SSEOutput } from '~/lib/execution-strategy'
import type { AnthropicStreamEventData } from '~/translator'

import { sse } from 'elysia'

/**
 * Serializes Anthropic stream events into SSE output items
 * (one `{ event, data }` per event, with `data` as the JSON-encoded event).
 */
export function serializeAnthropicSSE(events: Array<AnthropicStreamEventData>): SSEOutput[] {
  return events.map(event => ({ event: event.type, data: JSON.stringify(event) }))
}

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
