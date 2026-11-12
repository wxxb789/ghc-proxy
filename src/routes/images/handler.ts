import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ImageResponse, ImageStreamChunk } from '~/types'

import { cacheModels, createCopilotClient, createRequestRecoveryRecord } from '~/clients/factory'
import {
  parseImageEditFormData,
  parseImageEditRequest,
  parseImageGenerationRequest,
} from '~/ingest/validation/images'
import { throwInvalidRequestError } from '~/lib/error'
import { passthroughSSEChunk, runStrategy } from '~/lib/execution-strategy'
import { isTimeoutLikeError } from '~/lib/timeout-error'
import { ClientAbortError, createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { modelCache, runtimeStore } from '~/state'
import { resolveRequestModel } from '~/transform/resolve-model'
import { isAsyncIterable } from '~/util/async-iterable'

export interface ImageCoreParams {
  operation: 'generations' | 'edits'
  body: unknown
  request: Request
  requestId: string
  client?: CopilotClient
  recovery?: UpstreamRecoveryRecord
}

export async function handleImagesCore({
  operation,
  body,
  request,
  requestId,
  client,
  recovery,
}: ImageCoreParams): Promise<ExecutionResult> {
  const parsed = operation === 'generations'
    ? { kind: 'generations' as const, payload: parseImageGenerationRequest(body) }
    : {
        kind: 'edits' as const,
        payload: body instanceof FormData ? parseImageEditFormData(body) : parseImageEditRequest(body),
      }
  const onClientAbort = () => runtimeStore.requests.markAborted(requestId)
  if (request.signal.aborted) {
    onClientAbort()
    throw new ClientAbortError()
  }
  const upstreamSignal = createUpstreamSignalFromConfig(request.signal, undefined, onClientAbort)

  try {
    upstreamSignal.signal.throwIfAborted()
    const copilotClient = client ?? createCopilotClient(recovery ?? createRequestRecoveryRecord(request))
    const payload = parsed.payload
    const model = payload instanceof FormData ? payload.get('model') : payload.model

    // An omitted edit model belongs to the upstream; do not select a local default.
    if (typeof model === 'string') {
      runtimeStore.requests.recordRequestedModel(requestId, model)
      if (!modelCache.getModels())
        await cacheModels(copilotClient, { signal: upstreamSignal.signal })
      const modelPayload = { model }
      const resolved = resolveRequestModel({ payload: modelPayload, applyPolicy: false })
      runtimeStore.requests.recordModelMapping(requestId, resolved.modelMapping)
      if (!resolved.resolvedModel)
        throwInvalidRequestError('The selected model could not be resolved.', 'model')
      const endpoint = operation === 'generations' ? '/v1/images/generations' : '/v1/images/edits'
      if (!modelCache.supportsEndpoint(resolved.resolvedModel, endpoint))
        throwInvalidRequestError(`The selected model does not advertise ${endpoint}.`, 'model')

      if (payload instanceof FormData) {
        if (model !== resolved.model)
          payload.set('model', resolved.model)
      }
      else {
        payload.model = resolved.model
      }
    }

    return await runStrategy<ImageResponse | AsyncIterable<ImageStreamChunk>, ImageStreamChunk>({
      execute: () => parsed.kind === 'generations'
        ? copilotClient.createImageGeneration(parsed.payload, { signal: upstreamSignal.signal })
        : copilotClient.createImageEdit(parsed.payload, { signal: upstreamSignal.signal }),
      isStream: isAsyncIterable<ImageStreamChunk>,
      translateResult: result => result,
      translateStreamChunk: chunk => passthroughSSEChunk(chunk, chunk.data ?? ''),
      onStreamError(error) {
        const timeout = isTimeoutLikeError(error)
        return {
          event: 'error',
          data: JSON.stringify({
            error: {
              type: timeout ? 'timeout_error' : 'server_error',
              message: timeout ? 'Upstream image request timed out.' : 'Upstream image stream failed.',
            },
          }),
        }
      },
    }, upstreamSignal, {
      onStreamError: error => runtimeStore.recordStreamError(requestId, error),
    })
  }
  catch (error) {
    upstreamSignal.cleanup()
    if (request.signal.aborted && error instanceof DOMException && error.name === 'AbortError')
      throw new ClientAbortError()
    throw error
  }
}
