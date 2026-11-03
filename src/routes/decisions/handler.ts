import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { DecisionsRequest, DecisionsResponse } from '~/types'

import { cacheModels, createCopilotClient, createRequestRecoveryRecord } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError, withTranslationErrors } from '~/lib/error'
import { setRequestModelMapping } from '~/lib/request-logger'
import { ClientAbortError, createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { modelCache, runtimeStore, SYSTEMONE_ENDPOINT } from '~/state'
import { resolveRequestModel } from '~/transform/resolve-model'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { normalizeDecisionsUpstreamError } from '~/translator/decisions/errors'
import { translateDecisionsRequest } from '~/translator/decisions/openai-to-systemone'
import { assertDecisionsRequestSupported } from '~/translator/decisions/policy'
import { translateDecisionsResponse } from '~/translator/decisions/systemone-to-openai'

export interface DecisionsCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
  request: Request
  requestId: string
  recovery?: UpstreamRecoveryRecord
  client?: CopilotClient
}

export async function handleDecisionsCore(
  { body, signal, headers, request, requestId, recovery, client }: DecisionsCoreParams,
): Promise<DecisionsResponse> {
  const { payload, meta } = protocolRegistry.ingest<DecisionsRequest>(
    'openai-decisions',
    body,
    headers,
  )
  withTranslationErrors(() => assertDecisionsRequestSupported(payload))

  const upstreamSignal = createUpstreamSignalFromConfig(
    signal,
    undefined,
    () => runtimeStore.requests.markAborted(requestId),
  )

  try {
    // The shared helper intentionally ignores a client signal that was already
    // aborted when it was created (a historical Bun platform workaround). This
    // route still must refuse dispatch, so check the caller signal after the
    // helper has wired cleanup and record the cancellation explicitly.
    if (signal.aborted) {
      upstreamSignal.cleanup()
      runtimeStore.requests.markAborted(requestId)
      throw new ClientAbortError()
    }
    upstreamSignal.signal.throwIfAborted()

    const copilotClient = client ?? createCopilotClient(
      recovery ?? createRequestRecoveryRecord(request),
    )

    if (!modelCache.getModels())
      await cacheModels(copilotClient, { signal: upstreamSignal.signal })

    const resolved = resolveRequestModel({
      payload,
      betaHeaders: meta.betaHeaders,
      applyPolicy: false,
    })
    runtimeStore.requests.recordModelMapping(requestId, resolved.modelMapping)
    setRequestModelMapping(request, resolved.modelMapping)

    if (!resolved.resolvedModel)
      throwInvalidRequestError('The selected model could not be resolved.', 'model')
    if (!modelCache.supportsEndpoint(resolved.resolvedModel, SYSTEMONE_ENDPOINT)) {
      throwInvalidRequestError(
        'The selected model does not support the decisions endpoint.',
        'model',
      )
    }

    const translation = withTranslationErrors(() => translateDecisionsRequest(payload))
    let raw: unknown
    try {
      raw = await copilotClient.createSystemOne(translation.upstream, {
        signal: upstreamSignal.signal,
        errorMapper: (message, response) =>
          normalizeDecisionsUpstreamError(message, response, translation.questions),
      })
    }
    catch (error) {
      // A bare AbortError from a cancelled body read has no marker, so it
      // would be reclassified as a plain upstream 422 by the error mapper.
      // Tag it here so the shared client-abort path records the request as
      // aborted instead of failed. Deadline aborts stay timeout-shaped.
      if (
        error instanceof DOMException
        && error.name === 'AbortError'
        && upstreamSignal.clientSignal?.aborted
      ) {
        throw new ClientAbortError()
      }
      if (error instanceof SyntaxError) {
        withTranslationErrors(() => {
          throw new TranslationFailure('Upstream decisions response was not valid JSON.', {
            status: 502,
            kind: 'invalid_upstream_decisions_response',
          })
        })
      }
      throw error
    }

    return withTranslationErrors(() => translateDecisionsResponse(raw, translation))
  }
  finally {
    upstreamSignal.cleanup()
  }
}
