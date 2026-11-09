import type { Model, ResponsesPayload, ResponsesResult } from '~/types'

import { runtimeStore } from '~/state'
import { applyContextManagement, compactInputByLatestCompaction } from '~/transform/context-management'
import { applyResponsesParameterFilters, clampResponsesOutputTokens } from '~/transform/parameter-filter'
import { stripPhaseFromInputMessages } from '~/transform/responses-input'

/**
 * Apply the shaping every Copilot `/responses` upstream payload receives, and
 * record the matching `responses.*` effects on `requestId`.
 *
 * Both Responses dispatch paths call this — `POST /responses` passthrough and
 * the `/v1/messages` → Responses translation — so the steps and their order
 * live here once rather than in each caller. Caller-specific work stays with
 * the caller: tool transforms, the store / item_reference / remote-image input
 * policy, and model validation run before this; the `/responses` passthrough
 * clamps reasoning effort after it (the Messages translation limits effort
 * inside the translator).
 *
 * The order is fixed:
 * 1. Compaction runs first, so later effect counts describe only items that
 *    actually go upstream (phases on dropped items are not counted).
 * 2. Phase strip.
 * 3. Context management.
 * 4. Parameter filters run last among the rewrites so they can strip any
 *    parameter — including `context_management` injected above — that the
 *    model rejects, per the configured filter rules.
 * 5. Output-token floor clamp.
 *
 * Callers must invoke this before cloning `payload.input` for the emulator, so
 * the stored history matches what was sent upstream.
 */
export function shapeResponsesUpstreamPayload(
  payload: ResponsesPayload,
  model: Model | undefined,
  requestId: string,
): void {
  const compactedItems = compactInputByLatestCompaction(payload)
  if (compactedItems > 0)
    runtimeStore.requests.recordEffect(requestId, 'responses.input_compacted', compactedItems)

  const strippedPhases = stripPhaseFromInputMessages(payload)
  if (strippedPhases > 0)
    runtimeStore.requests.recordEffect(requestId, 'responses.phase_filtered', strippedPhases)

  const contextThreshold = applyContextManagement(payload, model?.capabilities.limits.max_prompt_tokens)
  if (contextThreshold !== undefined)
    runtimeStore.requests.recordEffect(requestId, 'responses.context_management')

  const removedParams = applyResponsesParameterFilters(payload, model)
  if (removedParams.length > 0)
    runtimeStore.requests.recordEffect(requestId, 'responses.parameter_filter', removedParams.length)

  if (clampResponsesOutputTokens(payload))
    runtimeStore.requests.recordEffect(requestId, 'responses.output_tokens_raised')

  // A null flag and an absent one both mean non-streaming, but the M365
  // gateway rejects null ("stream must be a boolean").
  if (payload.stream === null)
    delete payload.stream
}

export interface ResponsesTerminalObservers {
  onTerminalResponse: (response: ResponsesResult) => void
  onStreamEndWithoutTerminal: () => void
}

/**
 * Record upstream failures that arrive inside an HTTP 200 from a Copilot
 * `/responses` call: a terminal `failed` response, or a stream that ended
 * without any terminal event. A stream cut short by the client aborting is
 * not an upstream failure and is not recorded.
 */
export function createResponsesTerminalObservers(
  requestId: string,
  upstreamSignal: { clientSignal?: AbortSignal },
): ResponsesTerminalObservers {
  return {
    onTerminalResponse(response) {
      if (response.status === 'failed' || response.error)
        runtimeStore.requests.recordError(requestId, 'Upstream HTTP 200 (response_failed)')
    },
    onStreamEndWithoutTerminal() {
      if (upstreamSignal.clientSignal?.aborted)
        return
      runtimeStore.requests.recordError(requestId, 'Upstream HTTP 200 (response_stream_eof)')
    },
  }
}
