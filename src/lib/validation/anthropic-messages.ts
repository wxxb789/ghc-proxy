import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
} from '~/translator'

import { z } from 'zod'

import {
  createObjectSchemaDefinitionSchema,
  jsonObjectSchema,
  parsePayload,
} from './shared'

// ── Schema Definitions ──

const anthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).loose()

const anthropicImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string().min(1),
  }).loose(),
}).loose()

const anthropicThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
}).loose()

const anthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObjectSchema,
}).loose()

const anthropicToolResultContentBlockSchema = z.union([
  anthropicTextBlockSchema,
  anthropicImageBlockSchema,
])

const anthropicToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(anthropicToolResultContentBlockSchema),
  ]),
  is_error: z.boolean().optional(),
}).loose()

const anthropicUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.string(),
    z.array(z.union([
      anthropicTextBlockSchema,
      anthropicImageBlockSchema,
      anthropicToolResultBlockSchema,
    ])),
  ]),
}).loose()

const anthropicAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([
    z.string(),
    z.array(z.union([
      anthropicTextBlockSchema,
      anthropicThinkingBlockSchema,
      anthropicToolUseBlockSchema,
    ])),
  ]),
}).loose()

const anthropicMessageSchema = z.union([
  anthropicUserMessageSchema,
  anthropicAssistantMessageSchema,
])

const anthropicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: createObjectSchemaDefinitionSchema('tool input_schema must describe an object'),
}).loose()

const anthropicToolChoiceSchema = z.union([
  z.object({
    type: z.literal('auto'),
  }).loose(),
  z.object({
    type: z.literal('any'),
  }).loose(),
  z.object({
    type: z.literal('none'),
  }).loose(),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
  }).loose(),
])

const anthropicThinkingSchema = z.union([
  z.object({
    type: z.literal('disabled'),
  }).loose(),
  z.object({
    type: z.literal('adaptive'),
  }).loose(),
  z.object({
    type: z.literal('enabled'),
    budget_tokens: z.number().int().positive(),
  }).loose(),
])

const anthropicMessagesBasePayloadSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([
    z.string(),
    z.array(anthropicTextBlockSchema),
  ]).optional(),
  metadata: z.object({
    user_id: z.string().optional(),
  }).loose().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
  thinking: anthropicThinkingSchema.optional(),
  service_tier: z.enum(['auto', 'standard_only']).optional(),
}).loose().superRefine((payload, ctx) => {
  if (payload.tool_choice?.type === 'tool' && !payload.tools?.some(tool => tool.name === payload.tool_choice?.name)) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_choice.name must reference a declared tool',
      path: ['tool_choice', 'name'],
    })
  }
})

const anthropicMessagesPayloadSchema = anthropicMessagesBasePayloadSchema.extend({
  max_tokens: z.number().int().nonnegative(),
})

const anthropicCountTokensPayloadSchema = anthropicMessagesBasePayloadSchema.extend({
  max_tokens: z.number().int().nonnegative().optional(),
})

// ── Parse Functions ──

export function parseAnthropicMessagesPayload(payload: unknown): AnthropicMessagesPayload {
  return parsePayload(anthropicMessagesPayloadSchema, 'anthropic.messages', payload) as AnthropicMessagesPayload
}

export function parseAnthropicCountTokensPayload(payload: unknown): AnthropicCountTokensPayload {
  return parsePayload(anthropicCountTokensPayloadSchema, 'anthropic.messages.count_tokens', payload) as AnthropicCountTokensPayload
}
