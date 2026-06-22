import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'

import { setRequestModelMapping } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'

export type DeliveryResult
  = | { streaming: false, data: unknown }
    | { streaming: true, stream: AsyncGenerator<unknown> }

export function deliverResult(
  request: Request,
  result: ExecutionResult,
  modelMapping: ModelMappingInfo,
): DeliveryResult {
  setRequestModelMapping(request, modelMapping)
  if (result.kind === 'json') {
    return { streaming: false, data: result.data }
  }
  return { streaming: true, stream: sseAdapter(result.generator) }
}
