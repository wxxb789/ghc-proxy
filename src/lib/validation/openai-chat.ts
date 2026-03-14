import type { ChatCompletionsPayload } from '~/types'

import { z } from 'zod'

import { REASONING_EFFORT_VALUES } from '~/types'

import {
  createObjectSchemaDefinitionSchema,
  finiteNumberSchema,
  nonNegativeIntegerSchema,
  parsePayload,
} from './shared'

// ── Schema Definitions ──

const openAIPenaltySchema = finiteNumberSchema.min(-2).max(2)
const openAILogitBiasKeySchema = z.string().regex(/^\d+$/)
const openAILogitBiasValueSchema = finiteNumberSchema.min(-100).max(100)

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

// ── Parse Function ──

export function parseOpenAIChatPayload(payload: unknown): ChatCompletionsPayload {
  return parsePayload(openAIChatPayloadSchema, 'openai.chat', payload) as ChatCompletionsPayload
}
