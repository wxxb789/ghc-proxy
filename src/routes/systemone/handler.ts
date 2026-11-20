import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { SystemOneRequest, SystemOneResponse } from '~/types'

import { cacheModels, createCopilotClient, createRequestRecoveryRecord } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError, withTranslationErrors } from '~/lib/error'
import { getOrCreateRequestCorrelation } from '~/lib/request-logger'
import { withUpstreamSignal } from '~/lib/upstream-signal'
import { modelCache, runtimeStore, SYSTEMONE_ENDPOINT } from '~/state'
import { resolveRequestModel } from '~/transform/resolve-model'
import { callDecisionsUpstream, normalizeSystemOneUpstreamError } from '~/translator/decisions/errors'

import { validateSystemOneResponse } from './response'

interface SystemOneCoreParams {
  body: unknown
  request: Request
  recovery?: UpstreamRecoveryRecord
  client?: CopilotClient
}

export async function handleSystemOneCore(
  { body, request, recovery, client }: SystemOneCoreParams,
): Promise<SystemOneResponse> {
  const { requestId } = getOrCreateRequestCorrelation(request)
  const { headers, signal } = request
  const { payload, meta } = protocolRegistry.ingest<SystemOneRequest>('systemone', body, headers)
  return withUpstreamSignal(signal, () => runtimeStore.requests.markAborted(requestId), async (upstreamSignal) => {
    const copilotClient = client ?? createCopilotClient(recovery ?? createRequestRecoveryRecord(request))
    if (!modelCache.getModels()?.data.length)
      await cacheModels(copilotClient, { signal: upstreamSignal })

    const { resolvedModel, modelMapping } = resolveRequestModel({ payload, betaHeaders: meta.betaHeaders, applyPolicy: false })
    runtimeStore.requests.recordModelMapping(requestId, modelMapping)
    if (!resolvedModel || !modelCache.supportsEndpoint(resolvedModel, SYSTEMONE_ENDPOINT))
      throwInvalidRequestError('The selected model does not support the systemone endpoint.', 'model')

    const raw = await callDecisionsUpstream(
      () => copilotClient.createSystemOne({ ...payload, model: resolvedModel.id }, {
        signal: upstreamSignal,
        errorMapper: normalizeSystemOneUpstreamError,
      }),
      signal,
      'Upstream System One response was not valid JSON.',
      'invalid_upstream_systemone_response',
    )
    return withTranslationErrors(() => validateSystemOneResponse(raw, payload.questions))
  })
}
