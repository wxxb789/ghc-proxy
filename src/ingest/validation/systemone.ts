import type { SystemOneRequest, SystemOneState } from '~/types'

import { z } from 'zod'

import { isPlainObject, parsePayload } from './shared'

const MAX_MODEL = 1_048_576
const MAX_INPUT_STRING = 10_485_760
const MAX_QUESTION_INSTRUCTION = 1_048_576
const MAX_JSON_CONTAINER_LEVELS = 32
const MAX_JSON_VALUES = 10_000

function isBoundedJson(value: unknown): boolean {
  let remaining = MAX_JSON_VALUES
  function visit(item: unknown, depth: number): boolean {
    if (--remaining < 0)
      return false
    if (item === null || typeof item === 'boolean')
      return true
    if (typeof item === 'number')
      return Number.isFinite(item)
    if (typeof item === 'string')
      return item.length <= MAX_INPUT_STRING
    if (depth > MAX_JSON_CONTAINER_LEVELS)
      return false
    if (Array.isArray(item)) {
      for (const child of item) {
        if (!visit(child, depth + 1))
          return false
      }
      return true
    }
    if (!isPlainObject(item))
      return false
    for (const key of Object.keys(item)) {
      if (!visit(item[key], depth + 1))
        return false
    }
    return true
  }
  return visit(value, 1)
}

const plainObjectSchema = z.custom<Record<string, unknown>>(isPlainObject, 'Expected a plain JSON object')
const instructions = z.string().max(MAX_QUESTION_INSTRUCTION).optional()
const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('noul'),
    instructions,
    criteria: z.strictObject({ true: z.string().optional(), false: z.string().optional() }).nullable().optional(),
  }),
  z.strictObject({
    type: z.literal('choice'),
    instructions,
    criteria: plainObjectSchema.refine((criteria) => {
      const entries = Object.values(criteria)
      return entries.length > 0 && entries.every(value => value === null || typeof value === 'string')
    }, 'Expected at least one choice with a string or null criterion'),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions,
    criteria: z.array(z.string()).min(1),
  }),
])

// Validate dynamic-key objects in place: z.record would drop an own __proto__ key.
const questionsSchema = plainObjectSchema.superRefine((questions, ctx) => {
  const keys = Object.keys(questions)
  if (keys.length < 1 || keys.length > 255) {
    ctx.addIssue({ code: 'custom', message: 'Expected between 1 and 255 questions' })
    return
  }
  for (const key of keys) {
    if (!isPlainObject(questions[key])) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Expected a plain JSON question object' })
      continue
    }
    const parsed = questionSchema.safeParse(questions[key])
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: [key, ...issue.path] })
    }
  }
})

const systemOneRequestSchema = plainObjectSchema.pipe(z.strictObject({
  model: z.string().min(1).max(MAX_MODEL),
  state: z.custom<SystemOneState>(value => (typeof value === 'string' || Array.isArray(value) || isPlainObject(value))
    && isBoundedJson(value), 'Expected a string, object or array within the JSON size and depth limits'),
  questions: questionsSchema,
}))

export function parseSystemOneRequest(payload: unknown): SystemOneRequest {
  return parsePayload(systemOneRequestSchema, 'systemone', payload) as SystemOneRequest
}
