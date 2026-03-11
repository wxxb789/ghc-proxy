import type { Context } from 'hono'
import type { Model, ResponsesPayload, ResponsesResult } from '~/types'

import { streamSSE } from 'hono/streaming'

import { CopilotClient } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { shouldUseFunctionApplyPatch } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { modelSupportsEndpoint } from '~/lib/model-capabilities'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseResponsesPayload } from '~/lib/validation'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from './context-management'

const RESPONSES_ENDPOINT = '/responses'

export async function handleResponses(c: Context) {
  const payload = parseResponsesPayload(await c.req.json())

  applyResponsesToolTransforms(payload)
  applyResponsesInputPolicies(payload)
  compactInputByLatestCompaction(payload)

  const selectedModel = findSelectedModel(payload.model)
  if (!modelSupportsEndpoint(selectedModel, RESPONSES_ENDPOINT)) {
    throw new HTTPError(
      'The selected model does not support the responses endpoint.',
      Response.json(
        {
          error: {
            message: 'The selected model does not support the responses endpoint.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
    )
  }
  if (!selectedModel) {
    throw new HTTPError(
      'The selected model could not be resolved.',
      Response.json(
        {
          error: {
            message: 'The selected model could not be resolved.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
    )
  }

  applyContextManagement(
    payload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )

  const { vision, initiator } = getResponsesRequestOptions(payload)
  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createResponses(payload, {
    vision,
    initiator,
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    return streamSSE(c, async (stream) => {
      const tracker = createStreamIdTracker()
      try {
        for await (const chunk of response) {
          await stream.writeSSE({
            ...(chunk.id !== undefined ? { id: String(chunk.id) } : {}),
            ...(chunk.event ? { event: chunk.event } : {}),
            ...(chunk.comment ? { comment: chunk.comment } : {}),
            ...(chunk.retry !== undefined ? { retry: chunk.retry } : {}),
            data: fixStreamIds(chunk.data ?? '', chunk.event, tracker),
          })
        }
      }
      finally {
        cleanup()
      }
    })
  }

  try {
    return c.json(response as ResponsesResult)
  }
  finally {
    cleanup()
  }
}

function findSelectedModel(modelId: string): Model | undefined {
  return state.cache.models?.data.find(model => model.id === modelId)
}

function isStreamingRequested(payload: ResponsesPayload): boolean {
  return Boolean(payload.stream)
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value)
    && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}

function applyResponsesToolTransforms(payload: ResponsesPayload): void {
  applyFunctionApplyPatch(payload)
  rejectUnsupportedBuiltinTools(payload)
}

function applyFunctionApplyPatch(payload: ResponsesPayload): void {
  if (!shouldUseFunctionApplyPatch() || !Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (
      tool.type === 'custom'
      && typeof tool.name === 'string'
      && tool.name === 'apply_patch'
    ) {
      return {
        type: 'function',
        name: tool.name,
        description: 'Use the `apply_patch` tool to edit files',
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The entire contents of the apply_patch command',
            },
          },
          required: ['input'],
        },
        strict: false,
      }
    }

    return tool
  })
}

function rejectUnsupportedBuiltinTools(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools)) {
    return
  }

  for (const tool of payload.tools) {
    if (tool.type === 'web_search') {
      throwInvalidRequestError(
        'The selected Copilot endpoint does not support the Responses web_search tool.',
        'tools',
        'unsupported_tool_web_search',
      )
    }
  }
}

function applyResponsesInputPolicies(payload: ResponsesPayload): void {
  rejectUnsupportedRemoteImageUrls(payload)
}

function rejectUnsupportedRemoteImageUrls(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input) || !containsRemoteImageUrl(payload.input)) {
    return
  }

  throwInvalidRequestError(
    'The selected Copilot endpoint does not support external image URLs on the Responses API. Use file_id or data URL image input instead.',
    'input',
    'unsupported_input_image_remote_url',
  )
}

function containsRemoteImageUrl(value: unknown): boolean {
  if (!value) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some(entry => containsRemoteImageUrl(entry))
  }
  if (typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  if (
    record.type === 'input_image'
    && typeof record.image_url === 'string'
    && /^https?:\/\//i.test(record.image_url)
  ) {
    return true
  }

  return Object.values(record).some(entry => containsRemoteImageUrl(entry))
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

function throwInvalidRequestError(
  message: string,
  param: string,
  code?: string,
): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'invalid_request_error',
          param,
          ...(code ? { code } : {}),
        },
      },
      { status: 400 },
    ),
  )
}
