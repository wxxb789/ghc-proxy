import type { Context } from 'hono'
import type { Model, ResponsesPayload } from '~/types'

import { CopilotClient } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { shouldUseFunctionApplyPatch } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { executeStrategy } from '~/lib/execution-strategy'
import { modelSupportsEndpoint } from '~/lib/model-capabilities'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseResponsesPayload } from '~/lib/validation'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from './context-management'
import { createResponsesPassthroughStrategy } from './strategy'

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
  const upstreamSignal = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )
  const copilotClient = new CopilotClient(state.auth, getClientConfig())

  const strategy = createResponsesPassthroughStrategy(copilotClient, payload, {
    vision,
    initiator,
    requestContext: readCapiRequestContext(c.req.raw.headers),
    signal: upstreamSignal.signal,
  })

  return executeStrategy(c, strategy, upstreamSignal)
}

function findSelectedModel(modelId: string): Model | undefined {
  return state.cache.models?.data.find(model => model.id === modelId)
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
