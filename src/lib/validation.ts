import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
} from '~/translator'
import type {
  ChatCompletionsPayload,
  EmbeddingRequest,
  ResponsesInputTokensPayload,
  ResponsesPayload,
} from '~/types'

import consola from 'consola'
import { z } from 'zod'

import { REASONING_EFFORT_VALUES } from '~/types'

import { shouldUseFunctionApplyPatch } from './config'
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

const responsesInputTextSchema = z.object({
  type: z.enum(['input_text', 'output_text']),
  text: z.string(),
}).loose()

const responsesInputImageSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  detail: z.enum(['low', 'high', 'auto']).optional(),
}).loose().superRefine((item, ctx) => {
  if (!item.image_url && !item.file_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'input_image requires image_url or file_id',
    })
  }
})

const responsesInputFileSchema = z.object({
  type: z.literal('input_file'),
  file_id: z.string().nullable().optional(),
  file_url: z.string().nullable().optional(),
  file_data: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
}).loose().superRefine((item, ctx) => {
  if (!item.file_id && !item.file_url && !item.file_data) {
    ctx.addIssue({
      code: 'custom',
      message: 'input_file requires file_id, file_url, or file_data',
    })
  }

  if (item.file_data && !item.filename) {
    ctx.addIssue({
      code: 'custom',
      message: 'input_file with file_data requires filename',
    })
  }
})

const responsesUnknownContentSchema = z.object({
  type: z.string().min(1),
}).catchall(z.unknown()).superRefine((item, ctx) => {
  if (['input_text', 'output_text', 'input_image', 'input_file'].includes(item.type)) {
    ctx.addIssue({
      code: 'custom',
      message: `content item type ${item.type} must match the explicit schema`,
    })
  }
})

const responsesInputContentSchema = z.union([
  responsesInputTextSchema,
  responsesInputImageSchema,
  responsesInputFileSchema,
  responsesUnknownContentSchema,
])

const responsesMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([
    z.string(),
    z.array(responsesInputContentSchema),
  ]).optional(),
  status: z.string().optional(),
  phase: z.enum(['commentary', 'final_answer']).optional(),
}).loose()

const responsesFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
}).loose()

const responsesFunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.union([
    z.string(),
    z.array(responsesInputContentSchema),
  ]),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
}).loose()

const responsesReasoningSummarySchema = z.object({
  type: z.literal('summary_text'),
  text: z.string(),
}).loose()

const responsesReasoningInputSchema = z.object({
  id: z.string().optional(),
  type: z.literal('reasoning'),
  summary: z.array(responsesReasoningSummarySchema),
  encrypted_content: z.string().min(1),
}).loose()

const responsesCompactionInputSchema = z.object({
  id: z.string().min(1),
  type: z.literal('compaction'),
  encrypted_content: z.string().min(1),
}).loose()

const responsesItemReferenceInputSchema = z.object({
  type: z.literal('item_reference'),
  id: z.string().min(1),
}).loose()

const responsesUnknownInputItemSchema = z.object({
  type: z.string().min(1),
}).catchall(z.unknown()).superRefine((item, ctx) => {
  if (['message', 'function_call', 'function_call_output', 'reasoning', 'compaction', 'item_reference'].includes(item.type)) {
    ctx.addIssue({
      code: 'custom',
      message: `input item type ${item.type} must match the explicit schema`,
    })
  }
})

const responsesInputItemSchema = z.union([
  responsesMessageSchema,
  responsesFunctionCallSchema,
  responsesFunctionCallOutputSchema,
  responsesReasoningInputSchema,
  responsesCompactionInputSchema,
  responsesItemReferenceInputSchema,
  responsesUnknownInputItemSchema,
])

const responsesFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  parameters: jsonObjectSchema.nullable().optional(),
  strict: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
}).loose()

const responsesUnknownToolSchema = z.object({
  type: z.string().min(1),
}).catchall(z.unknown()).superRefine((tool, ctx) => {
  if (tool.type === 'function') {
    ctx.addIssue({
      code: 'custom',
      message: 'tool type function must match the explicit schema',
    })
  }
})

const responsesToolSchema = z.union([
  responsesFunctionToolSchema,
  responsesUnknownToolSchema,
])

const responsesToolChoiceSchema = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    name: z.string().min(1),
  }).loose(),
])

const responsesReasoningConfigSchema = z.object({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
  summary: z.enum(['auto', 'concise', 'detailed']).nullable().optional(),
}).loose()

const responsesTextFormatTextSchema = z.object({
  type: z.literal('text'),
}).loose()

const responsesTextFormatJsonObjectSchema = z.object({
  type: z.literal('json_object'),
}).loose()

const responsesTextFormatJsonSchemaSchema = z.object({
  type: z.literal('json_schema'),
  name: z.string().min(1),
  schema: jsonObjectSchema,
  description: z.string().nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).loose()

const responsesTextConfigSchema = z.object({
  format: z.union([
    responsesTextFormatTextSchema,
    responsesTextFormatJsonObjectSchema,
    responsesTextFormatJsonSchemaSchema,
  ]).nullable().optional(),
  verbosity: z.enum(['low', 'medium', 'high']).nullable().optional(),
}).loose()

const responsesContextManagementSchema = z.object({
  type: z.literal('compaction'),
  compact_threshold: nonNegativeIntegerSchema,
}).loose()

const responsesConversationSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().nullable().optional(),
  }).loose(),
])

function createResponsesPayloadSchema(options: {
  requireModel: boolean
}) {
  return z.object({
    model: options.requireModel
      ? z.string().min(1)
      : z.string().min(1).nullable().optional(),
    instructions: z.string().nullable().optional(),
    input: z.union([
      z.string(),
      z.array(responsesInputItemSchema),
      z.null(),
    ]).optional(),
    conversation: responsesConversationSchema.nullable().optional(),
    previous_response_id: z.string().nullable().optional(),
    tools: z.array(responsesToolSchema).nullable().optional(),
    tool_choice: responsesToolChoiceSchema.nullable().optional(),
    temperature: finiteNumberSchema.min(0).max(2).nullable().optional(),
    top_p: finiteNumberSchema.min(0).max(1).nullable().optional(),
    max_output_tokens: nonNegativeIntegerSchema.nullable().optional(),
    max_tool_calls: nonNegativeIntegerSchema.nullable().optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    stream: z.boolean().nullable().optional(),
    safety_identifier: z.string().nullable().optional(),
    prompt_cache_key: z.string().nullable().optional(),
    truncation: z.enum(['auto', 'disabled']).nullable().optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    store: z.boolean().nullable().optional(),
    user: z.string().nullable().optional(),
    prompt: z.union([z.string().min(1), jsonObjectSchema]).nullable().optional(),
    text: responsesTextConfigSchema.nullable().optional(),
    reasoning: responsesReasoningConfigSchema.nullable().optional(),
    context_management: z.array(responsesContextManagementSchema).nullable().optional(),
    include: z.array(z.string().min(1)).nullable().optional(),
    service_tier: z.string().nullable().optional(),
  }).loose().superRefine((payload, ctx) => {
    const toolChoice = payload.tool_choice
    if (
      toolChoice
      && typeof toolChoice === 'object'
      && 'name' in toolChoice
      && typeof toolChoice.name === 'string'
      && Array.isArray(payload.tools)
    ) {
      const declaredFunctionNames = payload.tools
        .filter((tool) => {
          if (tool.type === 'function' && typeof tool.name === 'string') {
            return true
          }
          return shouldUseFunctionApplyPatch()
            && tool.type === 'custom'
            && tool.name === 'apply_patch'
        })
        .map(tool => tool.name)
      if (!declaredFunctionNames.includes(toolChoice.name)) {
        ctx.addIssue({
          code: 'custom',
          message: 'tool_choice.name must reference a declared function tool',
          path: ['tool_choice', 'name'],
        })
      }
    }
  })
}

const responsesPayloadSchema = createResponsesPayloadSchema({ requireModel: true })
const responsesInputTokensPayloadSchema = createResponsesPayloadSchema({ requireModel: false })

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

export function parseResponsesPayload(payload: unknown): ResponsesPayload {
  const result = responsesPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('openai.responses', result.error.issues)
  }
  return result.data as ResponsesPayload
}

export function parseResponsesInputTokensPayload(payload: unknown): ResponsesInputTokensPayload {
  const result = responsesInputTokensPayloadSchema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload('openai.responses.input_tokens', result.error.issues)
  }
  return result.data as ResponsesInputTokensPayload
}
