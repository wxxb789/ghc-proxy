import type { CopilotClient } from '~/clients'
import type { EmbeddingRequest } from '~/types'

import { createCopilotClient } from '~/clients/factory'
import { protocolRegistry } from '~/ingest'

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
 * route does not go through `runPipeline`, so it constructs its own client.
 */
export async function handleEmbeddingsCore(
  body: unknown,
  headers: Headers,
  client?: CopilotClient,
): Promise<object> {
  const { payload } = protocolRegistry.ingest<EmbeddingRequest>(
    'embeddings',
    body,
    headers,
  )
  const copilotClient = client ?? createCopilotClient()
  return await copilotClient.createEmbeddings(normalizeEmbeddingRequest(payload))
}
