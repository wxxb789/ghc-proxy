import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
} from '~/translator'
import type { ChatCompletionsPayload, EmbeddingRequest } from '~/types'

import consola from 'consola'
import { z } from 'zod'

import { REASONING_EFFORT_VALUES } from '~/types'

import { HTTPError } from './error'

const jsonObjectSchema = z.object({}).catchall(z.unknown())
const finiteNumberSchema = z.number().finite()
const nonNegativeIntegerSchema = z.number().int().nonnegative()
const openAIPenaltySchema = finiteNumberSchema.min(-2).max(2)
const openAILogitBiasKeySchema = z.string().regex(/^\d+$/)
const openAILogitBiasValueSchema = finiteNumberSchema.min(-100).max(100)

function createObjectSchemaDefinitionSchema(message: string) {
  return jsonObjectSchema.superRefine((schema, ctx) => {
    const typeValue = schema.type
    if (typeValue !== undefined && typeValue !== 'object') {
      ctx.addIssue({
        code: 'custom',
        message,
      })
    }
  })
}

const openAITextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).loose()

const openAIImagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  }).loose(),
}).loose()

const openAIContentSchema = z.union([
  z.string(),
  z.null(),
  z.array(z.union([openAITextPartSchema, openAIImagePartSchema])),
])

const openAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }).loose(),
}).loose()

const openAIMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'developer']),
  content: openAIContentSchema,
  name: z.string().optional(),
  tool_calls: z.array(openAIToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
}).loose().superRefine((message, ctx) => {
  if (message.role === 'tool' && !message.tool_call_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool messages require tool_call_id',
      path: ['tool_call_id'],
    })
  }

  if (message.role !== 'assistant' && message.tool_calls) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_calls are only valid on assistant messages',
      path: ['tool_calls'],
    })
  }
})

const openAIToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: createObjectSchemaDefinitionSchema('tool function.parameters must describe an object'),
  }).loose(),
}).loose()

const openAIToolChoiceSchema = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }).loose(),
  }).loose(),
])

const openAIResponseFormatSchema = z.object({
  type: z.literal('json_object'),
})

const openAIChatPayloadSchema = z.object({
  model: z.string().min(1),
  messages: z.array(openAIMessageSchema).min(1),
  temperature: finiteNumberSchema.min(0).max(2).nullable().optional(),
  top_p: finiteNumberSchema.min(0).max(1).nullable().optional(),
  max_tokens: nonNegativeIntegerSchema.nullable().optional(),
  stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  n: z.number().int().positive().nullable().optional(),
  stream: z.boolean().nullable().optional(),
  frequency_penalty: openAIPenaltySchema.nullable().optional(),
  presence_penalty: openAIPenaltySchema.nullable().optional(),
  logit_bias: z.record(openAILogitBiasKeySchema, openAILogitBiasValueSchema).nullable().optional(),
  logprobs: z.boolean().nullable().optional(),
  response_format: openAIResponseFormatSchema.nullable().optional(),
  seed: z.number().int().nullable().optional(),
  tools: z.array(openAIToolSchema).nullable().optional(),
  tool_choice: openAIToolChoiceSchema.nullable().optional(),
  user: z.string().nullable().optional(),
  reasoning_effort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
  thinking_budget: z.number().int().positive().nullable().optional(),
}).loose().superRefine((payload, ctx) => {
  const toolChoice = payload.tool_choice

  if (
    toolChoice
    && typeof toolChoice === 'object'
    && 'function' in toolChoice
    && !payload.tools?.some(tool => tool.function.name === toolChoice.function.name)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_choice.function.name must reference a declared tool',
      path: ['tool_choice', 'function', 'name'],
    })
  }
})

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

const embeddingRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().min(1),
}).loose()

function throwInvalidPayload(context: string, issues: Array<z.core.$ZodIssue>) {
  consola.warn('Invalid request payload', { context, issues })
  throw new HTTPError(
    'Invalid request payload',
    new Response('Invalid request payload', { status: 400 }),
  )
}

export function parseOpenAIChatPayload(payload: unknown): ChatCompletionsPayload {
  const result = openAIChatPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('openai.chat', result.error.issues)
  }
  return result.data as ChatCompletionsPayload
}

export function parseAnthropicMessagesPayload(payload: unknown): AnthropicMessagesPayload {
  const result = anthropicMessagesPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('anthropic.messages', result.error.issues)
  }
  return result.data as AnthropicMessagesPayload
}

export function parseAnthropicCountTokensPayload(payload: unknown): AnthropicCountTokensPayload {
  const result = anthropicCountTokensPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('anthropic.messages.count_tokens', result.error.issues)
  }
  return result.data as AnthropicCountTokensPayload
}

export function parseEmbeddingRequest(payload: unknown): EmbeddingRequest {
  const result = embeddingRequestSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('openai.embeddings', result.error.issues)
  }
  return result.data as EmbeddingRequest
}
