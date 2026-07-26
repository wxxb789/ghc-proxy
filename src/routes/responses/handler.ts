import type { ResponsesStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'
import type { ResponseFunctionTool, ResponsesPayload, ResponsesResult, ResponseTool } from '~/types'
import consola from 'consola'
import { throwInvalidRequestError } from '~/lib/error'
import { runPipeline } from '~/pipeline/runner'
import { configStore, modelCache, RESPONSES_ENDPOINT } from '~/state'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '~/transform/context-management'
import { applyResponsesParameterFilters } from '~/transform/parameter-filter'
import { normalizeFunctionParametersSchemaForCopilot } from '~/translator/responses/function-schema'
import { decorateStoredResponse, persistEmulatorResponse, prepareEmulatorRequest } from './emulator'
import { responsesStrategyRegistry } from './strategy-registry'

const HTTP_URL_RE = /^https?:\/\//i

export interface ResponsesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export type ResponsesCoreResult = PipelineResult

/**
 * Core handler for responses endpoint. Orchestrates the standard pipeline
 * (ingest → transform → dispatch) via runPipeline, with the responses-specific
 * emulator request prep, tool/input policies, and context management applied
 * through the afterIngest / afterTransform lifecycle hooks.
 */
export async function handleResponsesCore(
  { body, signal, headers }: ResponsesCoreParams,
): Promise<ResponsesCoreResult> {
  const emulatorMode = configStore.isEmulatorEnabled()
  let originalPayload: ResponsesPayload | undefined
  let emulatorPrepared: ReturnType<typeof prepareEmulatorRequest> | undefined

  const pipelineResult = await runPipeline<ResponsesPayload, ResponsesStrategyContext>(
    { body, signal, headers },
    {
      protocol: 'responses',
      strategyRegistry: responsesStrategyRegistry,
      afterIngest({ payload }) {
        originalPayload = payload
        emulatorPrepared = emulatorMode ? prepareEmulatorRequest(payload) : undefined
        return emulatorPrepared?.upstreamPayload ?? payload
      },
      afterTransform({ payload, selectedModel }) {
        applyResponsesToolTransforms(payload)
        applyResponsesInputPolicies(payload)
        compactInputByLatestCompaction(payload)

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
          payload,
          selectedModel.capabilities.limits.max_prompt_tokens,
        )

        // Runs last so it can strip any request parameter — including fields
        // this proxy injects above (e.g. context_management) — that the model
        // rejects, per the configured filter rules.
        applyResponsesParameterFilters(payload, selectedModel)
      },
      buildStrategyContext({ payload, meta, copilotClient, upstreamSignal }) {
        const { vision, initiator } = getResponsesRequestOptions(payload)
        const prepared = emulatorPrepared
        const requestPayload = originalPayload ?? payload
        return {
          copilotClient,
          payload,
          upstreamSignal,
          requestContext: meta.requestContext ?? {},
          vision,
          initiator,
          decorateResponse: prepared
            ? (response: ResponsesResult) => decorateStoredResponse(response, requestPayload, prepared)
            : undefined,
          onTerminalResponse: prepared
            ? (terminalResponse: ResponsesResult) => {
                if (!prepared.shouldStore) {
                  return
                }
                persistEmulatorResponse(
                  terminalResponse,
                  prepared.effectiveInputItems,
                )
              }
            : undefined,
        }
      },
    },
  )

  return pipelineResult
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
