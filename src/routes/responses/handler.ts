import type { ResponsesStrategyContext } from './strategy-registry'
import type { PipelineResult } from '~/pipeline/runner'
import type { ResponseFunctionTool, ResponsesPayload, ResponsesResult, ResponseTool } from '~/types'
import consola from 'consola'
import { throwInvalidRequestError } from '~/lib/error'
import { runPipeline } from '~/pipeline/runner'
import { configStore, modelCache, RESPONSES_ENDPOINT } from '~/state'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '~/transform/context-management'
import { applyResponsesParameterFilters, clampResponsesOutputTokens, clampResponsesReasoningEffort } from '~/transform/parameter-filter'
import { stripPhaseFromInputMessages } from '~/transform/responses-input'
import { normalizeFunctionParametersSchemaForCopilot } from '~/translator/responses/function-schema'
import { decorateStoredResponse, persistEmulatorResponse, prepareEmulatorRequest } from './emulator'
import { responsesStrategyRegistry } from './strategy-registry'

const HTTP_URL_RE = /^https?:\/\//i

export interface ResponsesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
  requestId: string
  callerRequestId?: string
}

export type ResponsesCoreResult = PipelineResult

/**
 * Core handler for responses endpoint. Orchestrates the standard pipeline
 * (ingest → transform → dispatch) via runPipeline, with the responses-specific
 * emulator request prep, tool/input policies, and context management applied
 * through the afterIngest / afterTransform lifecycle hooks.
 */
export async function handleResponsesCore(
  { body, signal, headers, requestId, callerRequestId }: ResponsesCoreParams,
): Promise<ResponsesCoreResult> {
  const emulatorMode = configStore.isEmulatorEnabled()
  let originalPayload: ResponsesPayload | undefined
  let emulatorPrepared: ReturnType<typeof prepareEmulatorRequest> | undefined

  const pipelineResult = await runPipeline<ResponsesPayload, ResponsesStrategyContext>(
    { body, signal, headers, requestId, callerRequestId },
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
        clampResponsesOutputTokens(payload)
        clampResponsesReasoningEffort(payload, selectedModel)
      },
      buildStrategyContext({ payload, meta, selectedModel, copilotClient, upstreamSignal }) {
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
            ? (response: ResponsesResult) => decorateStoredResponse(
                { ...response, model: selectedModel?.id ?? response.model },
                requestPayload,
                prepared,
              )
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
}

function applyFunctionToolCompatibilityDefaults(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (!isResponseFunctionTool(tool)) {
      return tool
    }

    // Forward the caller's `strict` and omit the key entirely when they sent
    // none. This used to default to `true`, which opted the caller into a
    // stricter contract than they asked for and then required their schema to
    // be rewritten to satisfy it.
    //
    // `strict` has three states, not two: probed 2026-08-06
    // (`scripts/probes/tool-strict.ts`), a schema whose `required` names a key
    // absent from `properties` returns 200 with the key omitted and 400 with
    // `strict: false` — upstream runs a different validator when the key is
    // present at all. `null` is folded into omission rather than forwarded,
    // since the type permits it and forwarding it would trip that validator.
    //
    // `strict` is destructured out of the spread so a caller-sent `null` is
    // dropped rather than carried through by `...rest`.
    const { strict, ...rest } = tool
    return {
      ...rest,
      parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
      ...(strict != null ? { strict } : {}),
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
