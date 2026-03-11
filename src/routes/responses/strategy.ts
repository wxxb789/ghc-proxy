import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy } from '~/lib/execution-strategy'
import type { ResponsesPayload, ResponsesResult } from '~/types'

import { isAsyncIterable } from '~/lib/async-iterable'

interface ResponsesStreamChunk {
  id?: number | string
  event?: string
  data?: string
  comment?: string
  retry?: number
}

interface StreamIdState {
  responseId?: string
  itemIdsByOutputIndex: Map<number, string>
}

function createStreamIdTracker(): StreamIdState {
  return {
    itemIdsByOutputIndex: new Map(),
  }
}

function fixStreamIds(
  rawData: string,
  eventName: string | undefined,
  state: StreamIdState,
): string {
  if (!rawData) {
    return rawData
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawData) as Record<string, unknown>
  }
  catch {
    return rawData
  }

  if (eventName === 'response.created' || eventName === 'response.completed' || eventName === 'response.incomplete') {
    const response = parsed.response as Record<string, unknown> | undefined
    if (response?.id && typeof response.id === 'string') {
      state.responseId = response.id
    }
  }

  if (eventName === 'response.output_item.added' || eventName === 'response.output_item.done') {
    const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : undefined
    const item = parsed.item as Record<string, unknown> | undefined
    if (outputIndex !== undefined && typeof item?.id === 'string') {
      state.itemIdsByOutputIndex.set(outputIndex, item.id)
    }
  }

  if (
    (eventName === 'response.function_call_arguments.delta'
      || eventName === 'response.function_call_arguments.done'
      || eventName === 'response.output_text.delta'
      || eventName === 'response.output_text.done'
      || eventName === 'response.reasoning_summary_text.delta'
      || eventName === 'response.reasoning_summary_text.done')
    && typeof parsed.output_index === 'number'
  ) {
    const stableId = state.itemIdsByOutputIndex.get(parsed.output_index)
    if (stableId && parsed.item_id !== stableId) {
      parsed.item_id = stableId
    }
  }

  if (state.responseId && parsed.response && typeof parsed.response === 'object') {
    const response = parsed.response as Record<string, unknown>
    if (response.id !== state.responseId) {
      response.id = state.responseId
    }
  }

  return JSON.stringify(parsed)
}

export function createResponsesPassthroughStrategy(
  copilotClient: CopilotClient,
  payload: ResponsesPayload,
  options: {
    vision: boolean
    initiator: 'user' | 'agent'
    requestContext: Partial<CapiRequestContext>
    signal: AbortSignal
  },
): ExecutionStrategy<ResponsesResult | AsyncIterable<ResponsesStreamChunk>, ResponsesStreamChunk> {
  const tracker = createStreamIdTracker()

  return {
    execute() {
      return copilotClient.createResponses(payload, options) as Promise<ResponsesResult | AsyncIterable<ResponsesStreamChunk>>
    },

    isStream(result): result is AsyncIterable<ResponsesStreamChunk> {
      return Boolean(payload.stream) && isAsyncIterable(result)
    },

    translateResult(result) {
      return result as ResponsesResult
    },

    translateStreamChunk(chunk) {
      return {
        ...(chunk.id !== undefined ? { id: String(chunk.id) } : {}),
        ...(chunk.event ? { event: chunk.event } : {}),
        ...(chunk.comment ? { comment: chunk.comment } : {}),
        ...(chunk.retry !== undefined ? { retry: chunk.retry } : {}),
        data: fixStreamIds(chunk.data ?? '', chunk.event, tracker),
      }
    },
  }
}
