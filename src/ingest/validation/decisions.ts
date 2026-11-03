import type { DecisionsRequest } from '~/types'

import { z } from 'zod'

import { parsePayload } from './shared'

const MAX_INPUT_STRING = 10_485_760
const MAX_INPUT_ITEMS = 131_072
const MAX_CONTENT_PARTS = 16_384
const MAX_QUESTION_INSTRUCTION = 1_048_576
const MAX_NAME = 1_048_576
const MAX_MODEL = 1_048_576
const MAX_JSON_PART_BYTES = 256 * 1024
const MAX_JSON_CONTAINER_LEVELS = 32
const MAX_JSON_VALUES = 10_000

const namespacedNameSchema = z.string().regex(/^[\w.-]+$/).min(1).max(128)
const customToolNameSchema = z.string().regex(/^[\w-]+$/).min(1).max(64)
const toolStatusSchema = z.enum(['in_progress', 'completed', 'incomplete']).nullable().optional()

const promptCacheBreakpointSchema = z.object({
  mode: z.literal('explicit').optional(),
}).strict().nullable().optional()

const textPartSchema = z.object({
  type: z.literal('input_text'),
  text: z.string().max(MAX_INPUT_STRING),
  prompt_cache_breakpoint: promptCacheBreakpointSchema,
}).strict()

const imagePartSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().min(1).max(1_073_741_824),
  detail: z.enum(['low', 'high', 'auto', 'original']).nullable().optional(),
  prompt_cache_breakpoint: promptCacheBreakpointSchema,
}).strict()

type DecisionsJsonData = Record<string, unknown> | Array<Record<string, unknown>>

function isDecisionsJsonData(value: unknown): value is DecisionsJsonData {
  if (Array.isArray(value))
    return value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `z.record` rebuilds the object and drops an own `__proto__` key, which would
// silently change accepted evidence. `z.custom` instead validates the shape
// while handing the original object through unchanged.
const jsonDataSchema = z.custom<DecisionsJsonData>(isDecisionsJsonData, {
  message: 'input_json.data must be an object or an array of objects',
})

function addJsonLimitIssues(
  data: Record<string, unknown> | Array<Record<string, unknown>>,
  ctx: z.RefinementCtx,
): void {
  let values = 0
  let maxDepth = 0
  let depthOverflow = false
  let valueOverflow = false

  // Bound the walk itself, not only the reported limits: JSON.parse can hand
  // us nesting far deeper than the cap, and recursing to the leaf first would
  // overflow the stack before any issue is recorded. Stop as soon as a limit
  // is crossed so the response is always the over-limit 400.
  const walk = (value: unknown, depth: number): void => {
    values++
    if (depth > MAX_JSON_CONTAINER_LEVELS) {
      depthOverflow = true
      maxDepth = depth
      return
    }
    if (values > MAX_JSON_VALUES) {
      valueOverflow = true
      return
    }
    if (typeof value !== 'object' || value === null)
      return
    maxDepth = Math.max(maxDepth, depth)
    if (Array.isArray(value)) {
      for (const item of value)
        walk(item, depth + 1)
      return
    }
    for (const item of Object.values(value))
      walk(item, depth + 1)
  }

  walk(data, 1)

  if (depthOverflow || maxDepth > MAX_JSON_CONTAINER_LEVELS) {
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: `input_json.data exceeds ${MAX_JSON_CONTAINER_LEVELS} container levels`,
    })
  }

  if (valueOverflow || values > MAX_JSON_VALUES) {
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: `input_json.data exceeds ${MAX_JSON_VALUES} values`,
    })
  }

  if (depthOverflow || valueOverflow)
    return

  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength
    if (bytes > MAX_JSON_PART_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `input_json.data exceeds ${MAX_JSON_PART_BYTES} compact UTF-8 bytes`,
      })
    }
  }
  catch {
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'input_json.data is not serializable JSON',
    })
  }
}

const jsonPartSchema = z.object({
  type: z.literal('input_json'),
  data: jsonDataSchema,
}).strict().superRefine((part, ctx) => {
  addJsonLimitIssues(part.data, ctx)
})

const outputTextPartSchema = z.object({
  type: z.literal('output_text'),
  text: z.string().max(MAX_INPUT_STRING),
}).strict()

const refusalPartSchema = z.object({
  type: z.literal('refusal'),
  refusal: z.string().max(MAX_INPUT_STRING),
}).strict()

const inputPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imagePartSchema,
  jsonPartSchema,
  outputTextPartSchema,
  refusalPartSchema,
])

const outputPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imagePartSchema,
])

const messageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'developer', 'system', 'assistant']),
  content: z.union([
    z.string().max(MAX_INPUT_STRING),
    z.array(inputPartSchema).max(MAX_CONTENT_PARTS),
  ]),
  phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
}).strict()

const functionCallSchema = z.object({
  type: z.literal('function_call'),
  arguments: z.string().max(1_048_576),
  call_id: z.string().min(1).max(64),
  name: namespacedNameSchema,
  id: z.string().max(1_048_576).nullable().optional(),
  namespace: z.string().regex(/^[\w-]+$/).min(1).max(64).nullable().optional(),
  status: toolStatusSchema,
}).strict()

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  output: z.union([
    z.string().max(MAX_INPUT_STRING),
    z.array(outputPartSchema).max(MAX_CONTENT_PARTS),
  ]),
  call_id: z.string().min(1).max(64),
  id: z.string().max(1_048_576).nullable().optional(),
  status: toolStatusSchema,
}).strict()

const customToolCallSchema = z.object({
  type: z.literal('custom_tool_call'),
  input: z.string().max(1_048_576),
  call_id: z.string().min(1).max(64),
  name: customToolNameSchema,
  id: z.string().max(1_048_576).nullable().optional(),
  namespace: z.string().regex(/^[\w-]+$/).min(1).max(64).nullable().optional(),
  status: toolStatusSchema,
}).strict()

const customToolCallOutputSchema = z.object({
  type: z.literal('custom_tool_call_output'),
  output: z.union([
    z.string().max(MAX_INPUT_STRING),
    z.array(outputPartSchema).max(MAX_CONTENT_PARTS),
  ]),
  call_id: z.string().min(1).max(64),
  id: z.string().max(1_048_576).nullable().optional(),
  status: toolStatusSchema,
}).strict()

const inputItemSchema = z.union([
  messageSchema,
  functionCallSchema,
  functionCallOutputSchema,
  customToolCallSchema,
  customToolCallOutputSchema,
])

const questionInputPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imagePartSchema,
  jsonPartSchema,
])

const questionInstructionsSchema = z.union([
  z.string().max(MAX_QUESTION_INSTRUCTION),
  z.array(questionInputPartSchema).min(1).max(MAX_CONTENT_PARTS),
])

const predicateQuestionSchema = z.object({
  type: z.literal('predicate'),
  name: z.string().max(MAX_NAME).optional(),
  instructions: questionInstructionsSchema,
}).strict()

const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  name: z.string().max(MAX_NAME).optional(),
  instructions: questionInstructionsSchema,
  choices: z.array(z.object({
    value: z.union([z.string().max(MAX_NAME), z.boolean()]),
    description: z.string().max(MAX_NAME).optional(),
  }).strict()).min(2).max(255),
}).strict()

const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  name: z.string().max(MAX_NAME).optional(),
  instructions: questionInstructionsSchema,
  levels: z.array(z.object({
    label: z.string().max(MAX_NAME),
    description: z.string().max(MAX_NAME).optional(),
  }).strict()).min(2).max(10),
}).strict()

const questionSchema = z.discriminatedUnion('type', [
  predicateQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
])

const decisionsRequestSchema = z.object({
  model: z.string().min(1).max(MAX_MODEL),
  input: z.union([
    z.string().max(MAX_INPUT_STRING),
    z.array(inputItemSchema).max(MAX_INPUT_ITEMS),
  ]),
  questions: z.array(questionSchema).min(1).max(400),
  safety_identifier: z.string().max(128).nullable().optional(),
  prompt_cache_key: z.string().max(64).nullable().optional(),
  prompt_cache_options: z.object({
    mode: z.enum(['implicit', 'explicit']).nullable().optional(),
    ttl: z.literal('30m').optional(),
  }).strict().nullable().optional(),
}).strict()

export function parseDecisionsRequest(payload: unknown): DecisionsRequest {
  return parsePayload(decisionsRequestSchema, 'openai.decisions', payload) as DecisionsRequest
}
