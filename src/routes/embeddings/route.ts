import { Hono } from "hono"

import { parseEmbeddingRequest } from "~/lib/validation"
import { createEmbeddings } from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  const payload = parseEmbeddingRequest(await c.req.json())
  const response = await createEmbeddings(payload)

  return c.json(response)
})
