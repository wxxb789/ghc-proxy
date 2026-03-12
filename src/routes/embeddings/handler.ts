import { CopilotClient } from '~/clients'
import { getClientConfig, state } from '~/lib/state'
import { parseEmbeddingRequest } from '~/lib/validation'

/**
 * Framework-agnostic handler for creating embeddings.
 */
export async function handleEmbeddingsCore(body: unknown): Promise<object> {
  const payload = parseEmbeddingRequest(body)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  return await copilotClient.createEmbeddings(payload)
}
