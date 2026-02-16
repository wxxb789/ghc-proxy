import { Hono } from 'hono'

import { CopilotClient } from '~/clients'
import { getClientConfig } from '~/lib/client-config'
import { state } from '~/lib/state'
import { parseEmbeddingRequest } from '~/lib/validation'

export const embeddingRoutes = new Hono()

embeddingRoutes.post('/', async (c) => {
  const payload = parseEmbeddingRequest(await c.req.json())
  const copilotClient = new CopilotClient(state.auth, getClientConfig(state))
  const response = await copilotClient.createEmbeddings(payload)

  return c.json(response)
})
