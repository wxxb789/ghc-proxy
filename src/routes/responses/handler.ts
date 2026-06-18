import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'

import type { ResponseFunctionTool, ResponsesPayload, ResponsesResult, ResponseTool } from '~/types'
import consola from 'consola'
import { createCopilotClient } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError } from '~/lib/error'
import { normalizeFunctionParametersSchemaForCopilot } from '~/lib/function-schema'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { configStore, modelCache, RESPONSES_ENDPOINT } from '~/state'
import { responsesModelChain } from '~/transform'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from './context-management'
import { decorateStoredResponse, persistEmulatorResponse, prepareEmulatorRequest } from './emulator'
import { responsesStrategyRegistry } from './strategy-registry'

const HTTP_URL_RE = /^https?:\/\//i

export interface ResponsesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface ResponsesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

/**
 * Core handler for responses endpoint.
 */
export async function handleResponsesCore(
  { body, signal, headers }: ResponsesCoreParams,
): Promise<ResponsesCoreResult> {
  const { payload, meta } = protocolRegistry.ingest<ResponsesPayload>(
    'responses',
    body,
    headers,
  )
  const requestContext = meta.requestContext
  const emulatorMode = configStore.isEmulatorEnabled()
  const emulatorPrepared = emulatorMode
    ? prepareEmulatorRequest(payload)
    : undefined

  const effectivePayload = emulatorPrepared?.upstreamPayload ?? payload

  // Run model transform chain (rewrite step)
  const transformResult = responsesModelChain.apply({ model: effectivePayload.model, payload: effectivePayload, headers })
  effectivePayload.model = transformResult.model

  applyResponsesToolTransforms(effectivePayload)
  applyResponsesInputPolicies(effectivePayload)
  compactInputByLatestCompaction(effectivePayload)

  const selectedModel = modelCache.findById(effectivePayload.model)
  if (!selectedModel) {
    throwInvalidRequestError(
      'The selected model could not be resolved.',
      'model',
    )
  }
  if (!modelCache.supportsEndpoint(selectedModel, RESPONSES_ENDPOINT)) {
    throwInvalidRequestError(
      'The selected model does not support the responses endpoint.',
      'model',
    )
  }

  applyContextManagement(
    effectivePayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )

  const { vision, initiator } = getResponsesRequestOptions(effectivePayload)
  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()
  const decorateResponse = emulatorPrepared
    ? (response: ResponsesResult) => decorateStoredResponse(response, payload, emulatorPrepared)
    : undefined

  const entry = responsesStrategyRegistry.select(selectedModel)
  const result = await entry.execute({
    copilotClient,
    payload: effectivePayload,
    upstreamSignal,
    requestContext: requestContext ?? {},
    vision,
    initiator,
    decorateResponse,
    onTerminalResponse: emulatorPrepared
      ? (terminalResponse: ResponsesResult) => {
          if (!emulatorPrepared?.shouldStore) {
            return
          }
          persistEmulatorResponse(
            terminalResponse,
            emulatorPrepared.effectiveInputItems,
          )
        }
      : undefined,
  })

  if (
    emulatorPrepared
    && result.kind === 'json'
  ) {
    const emulatedResponse = decorateStoredResponse(
      result.data as ResponsesResult,
      payload,
      emulatorPrepared,
    )
    if (emulatorPrepared.shouldStore) {
      persistEmulatorResponse(emulatedResponse, emulatorPrepared.effectiveInputItems)
    }
    result.data = emulatedResponse
  }

  const originalModel = transformResult.trace.length > 0 ? transformResult.trace[0].from : effectivePayload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({ tag: r.tag as ModelTransformTag, from: r.from, to: r.to })),
  }

  return { result, modelMapping }
}

function applyResponsesToolTransforms(payload: ResponsesPayload): void {
  applyFunctionApplyPatch(payload)
  applyFunctionToolCompatibilityDefaults(payload)
  rejectUnsupportedBuiltinTools(payload)
}

function applyFunctionToolCompatibilityDefaults(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (!isResponseFunctionTool(tool)) {
      return tool
    }

    return {
      ...tool,
      parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
      strict: tool.strict ?? true,
    }
  })
}

function isResponseFunctionTool(tool: ResponseTool): tool is ResponseFunctionTool {
  return tool.type === 'function'
}

function applyFunctionApplyPatch(payload: ResponsesPayload): void {
  if (!configStore.isFunctionApplyPatchEnabled() || !Array.isArray(payload.tools)) {
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
  if (
    payload.tool_choice
    && typeof payload.tool_choice === 'object'
    && 'type' in payload.tool_choice
    && (payload.tool_choice.type === 'web_search_preview'
      || payload.tool_choice.type === 'web_search_preview_2025_03_11')
  ) {
    throwInvalidRequestError(
      'The selected Copilot endpoint does not support the Responses web_search tool.',
      'tool_choice',
      'unsupported_tool_web_search',
    )
  }

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
  // Force store=false so Copilot never returns opaque item IDs that it
  // cannot resolve on subsequent requests (→ 404). Clients should also
  // set { "store": false } in their Provider Options.
  payload.store = false

  stripUnresolvableInputItems(payload)
  stripPhaseFromInputMessages(payload)
  rejectUnsupportedRemoteImageUrls(payload)
}

/**
 * Strip `phase` from input message items. The `phase` field is an output
 * annotation that some models may reject when sent back as input.
 */
function stripPhaseFromInputMessages(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input)) {
    return
  }

  let stripped = 0
  for (const item of payload.input) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    const isMessage = !('type' in rec) || rec.type === 'message'
    if (isMessage && 'phase' in rec) {
      delete rec.phase
      stripped++
    }
  }

  if (stripped > 0) {
    consola.debug(`Stripped phase from ${stripped} input message item(s)`)
  }
}

/**
 * Remove input items that Copilot cannot resolve and would trigger 404:
 * - `item_reference` items (opaque IDs from store=true sessions)
 * - `function_call_output` items whose `call_id` has no matching prior
 *   `function_call` in the same input array (orphaned outputs)
 */
function stripUnresolvableInputItems(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input)) {
    return
  }

  const functionCallIds = new Set<string>()
  for (const item of payload.input) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    if (rec.type === 'function_call' && typeof rec.call_id === 'string') {
      functionCallIds.add(rec.call_id)
    }
  }

  const originalLength = payload.input.length
  payload.input = payload.input.filter((item) => {
    if (typeof item !== 'object' || item === null) {
      return true
    }

    const rec = item as Record<string, unknown>

    if (rec.type === 'item_reference') {
      return false
    }

    if (
      rec.type === 'function_call_output'
      && typeof rec.call_id === 'string'
      && !functionCallIds.has(rec.call_id)
    ) {
      return false
    }

    return true
  })

  if (payload.input.length !== originalLength) {
    consola.debug(
      `Stripped ${originalLength - payload.input.length} unresolvable input items`
      + ` (item_reference / orphaned function_call_output)`,
    )
  }
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
    && HTTP_URL_RE.test(record.image_url)
  ) {
    return true
  }

  return Object.values(record).some(entry => containsRemoteImageUrl(entry))
}
