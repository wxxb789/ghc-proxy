import consola from "consola"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { EmbeddingRequest } from "~/services/copilot/create-embeddings"

import { HTTPError } from "./error"

const openAIMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.any()), z.null()]),
    name: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
    tool_call_id: z.string().optional(),
  })
  .loose()

const openAIChatPayloadSchema = z
  .object({
    model: z.string(),
    messages: z.array(openAIMessageSchema).min(1),
  })
  .loose()

const anthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.any())]),
  })
  .loose()

const anthropicMessagesPayloadSchema = z
  .object({
    model: z.string(),
    messages: z.array(anthropicMessageSchema).min(1),
    max_tokens: z.number(),
  })
  .loose()

const embeddingRequestSchema = z
  .object({
    input: z.union([z.string(), z.array(z.string())]),
    model: z.string(),
  })
  .loose()

const throwInvalidPayload = (
  context: string,
  issues: Array<z.core.$ZodIssue>,
) => {
  consola.warn("Invalid request payload", { context, issues })
  throw new HTTPError(
    "Invalid request payload",
    new Response("Invalid request payload", { status: 400 }),
  )
}

export const parseOpenAIChatPayload = (
  payload: unknown,
): ChatCompletionsPayload => {
  const result = openAIChatPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload("openai.chat", result.error.issues)
  }
  return result.data as ChatCompletionsPayload
}

export const parseAnthropicMessagesPayload = (
  payload: unknown,
): AnthropicMessagesPayload => {
  const result = anthropicMessagesPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload("anthropic.messages", result.error.issues)
  }
  return result.data as AnthropicMessagesPayload
}

export const parseEmbeddingRequest = (payload: unknown): EmbeddingRequest => {
  const result = embeddingRequestSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload("openai.embeddings", result.error.issues)
  }
  return result.data as EmbeddingRequest
}
