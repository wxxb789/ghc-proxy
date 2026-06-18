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
 */
export async function handleEmbeddingsCore(body: unknown, headers: Headers): Promise<object> {
  const { payload } = protocolRegistry.ingest<EmbeddingRequest>(
    'embeddings',
    body,
    headers,
  )
  const copilotClient = createCopilotClient()
  return await copilotClient.createEmbeddings(normalizeEmbeddingRequest(payload))
}
