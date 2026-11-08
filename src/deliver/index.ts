import type { ExecutionResult } from '~/lib/execution-strategy'

import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'
import { runtimeStore } from '~/state'

export type DeliveryResult
  = | { streaming: false, data: unknown }
    | { streaming: true, stream: AsyncGenerator<unknown> }

export function deliverResult(
  request: Request,
  result: ExecutionResult,
): DeliveryResult {
  if (result.kind === 'json') {
    return { streaming: false, data: result.data }
  }
  runtimeStore.requests.markStreaming(
    getOrCreateRequestCorrelation(request).requestId,
  )
  return { streaming: true, stream: sseAdapter(result.generator) }
}
