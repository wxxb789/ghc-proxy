import type { EmbeddingRequest } from '~/types'

import { z } from 'zod'

import { nonNegativeIntegerSchema, parsePayload } from './shared'

// ── Schema Definition ──

const embeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().min(1),
  dimensions: nonNegativeIntegerSchema.optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  user: z.string().min(1).optional(),
}).loose()

// ── Parse Function ──

export function parseEmbeddingRequest(payload: unknown): EmbeddingRequest {
  return parsePayload(embeddingRequestSchema, 'openai.embeddings', payload) as EmbeddingRequest
}
