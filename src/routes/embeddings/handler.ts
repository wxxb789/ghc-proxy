import type { CopilotClient } from '~/clients'
import type { UpstreamRecoveryRecord } from '~/clients/upstream-queue'
import type { EmbeddingRequest } from '~/types'

import { createCopilotClient } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'
import { withUpstreamSignal } from '~/lib/upstream-signal'

function normalizeEmbeddingRequest(payload: EmbeddingRequest): EmbeddingRequest {
  return {
    ...payload,
    input: typeof payload.input === 'string' ? [payload.input] : payload.input,
  }
}

/**
 * Core handler for creating embeddings.
 *
 * `client` is an injection seam for tests; production callers omit it. This
 * route does not go through `runPipeline`, so it constructs its own client and
 * derives its own upstream signal — otherwise a client disconnect would leave
 * the upstream request running and the configured timeout unenforced.
 */
export async function handleEmbeddingsCore(
  body: unknown,
  headers: Headers,
  client?: CopilotClient,
  signal?: AbortSignal,
  recovery?: UpstreamRecoveryRecord,
  onClientAbort?: () => void,
): Promise<object> {
  const { payload } = protocolRegistry.ingest<EmbeddingRequest>(
    'embeddings',
    body,
    headers,
  )
  const copilotClient = client ?? createCopilotClient(recovery)
  const request = normalizeEmbeddingRequest(payload)
  if (!signal)
    return copilotClient.createEmbeddings(request, {})

  return withUpstreamSignal(signal, onClientAbort, upstreamSignal =>
    copilotClient.createEmbeddings(request, { signal: upstreamSignal }))
}
