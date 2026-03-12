import { createCopilotClient } from '~/lib/state'
import { parseEmbeddingRequest } from '~/lib/validation'

/**
 * Core handler for creating embeddings.
 */
export async function handleEmbeddingsCore(body: unknown): Promise<object> {
  const payload = parseEmbeddingRequest(body)
  const copilotClient = createCopilotClient()
  return await copilotClient.createEmbeddings(payload)
}
