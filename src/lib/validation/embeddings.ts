import type { EmbeddingRequest } from '~/types'

import { z } from 'zod'

import { parsePayload } from './shared'

// ── Schema Definition ──

const embeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().min(1),
}).loose()

// ── Parse Function ──

export function parseEmbeddingRequest(payload: unknown): EmbeddingRequest {
  return parsePayload(embeddingRequestSchema, 'openai.embeddings', payload) as EmbeddingRequest
}
