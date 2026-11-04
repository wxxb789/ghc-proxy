import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'

import { getOrCreateRequestCorrelation, setRequestModelMapping } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'
import { runtimeStore } from '~/state'

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
  const { requestId } = getOrCreateRequestCorrelation(request)
  runtimeStore.requests.markStreaming(requestId)
  return {
    streaming: true,
    stream: (async function* () {
      try {
        yield* sseAdapter(result.generator)
      }
      finally {
        runtimeStore.requests.finishStream(requestId)
      }
    })(),
  }
}
