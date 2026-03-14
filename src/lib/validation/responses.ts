import type {
  ResponsesInputTokensPayload,
  ResponsesPayload,
} from '~/types'

import { z } from 'zod'

import { shouldUseFunctionApplyPatch } from '../config'

import {
  finiteNumberSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  parsePayload,
} from './shared'

// ── Content Schemas ──

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

// ── Input Item Schemas ──

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

// ── Tool Schemas ──

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

// ── Config Schemas ──

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

// ── Payload Schemas ──

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

// ── Parse Functions ──

export function parseResponsesPayload(payload: unknown): ResponsesPayload {
  return parsePayload(responsesPayloadSchema, 'openai.responses', payload) as ResponsesPayload
}

export function parseResponsesInputTokensPayload(payload: unknown): ResponsesInputTokensPayload {
  return parsePayload(responsesInputTokensPayloadSchema, 'openai.responses.input_tokens', payload) as ResponsesInputTokensPayload
}
