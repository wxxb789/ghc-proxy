import type { SystemOneRequest, SystemOneResponse } from '~/types'

import { z } from 'zod'

import { finiteNumberSchema, isPlainObject, nonNegativeIntegerSchema } from '~/ingest/validation/shared'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

const probability = z.number().min(0).max(1)
const probabilities = z.custom<Record<string, unknown>>(isPlainObject)
  .refine(values => Object.values(values).every(value => probability.safeParse(value).success))
const coordinates = z.object({ top: finiteNumberSchema, bottom: finiteNumberSchema, left: finiteNumberSchema, right: finiteNumberSchema })
  .refine(box => box.top <= box.bottom && box.left <= box.right)
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities }),
  z.object({ type: z.literal('score'), score: finiteNumberSchema, confidence: probability, legend: z.custom(isPlainObject), probabilities }),
  z.object({ type: z.literal('box'), box: coordinates, confidence: probability.nullable() }),
  z.object({ type: z.literal('refusal') }),
])
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.custom<Record<string, unknown>>(isPlainObject),
  usage: z.object({ input_tokens: nonNegativeIntegerSchema, output_tokens: nonNegativeIntegerSchema }),
})

function invalidSystemOneResponse(message: string): never {
  throw new TranslationFailure(message, {
    status: 502,
    kind: 'invalid_upstream_systemone_response',
  })
}

export function validateSystemOneResponse(raw: unknown, questions: SystemOneRequest['questions']): SystemOneResponse {
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success)
    invalidSystemOneResponse('Upstream System One response has an invalid shape.')

  const { answers } = parsed.data
  const keys = Object.keys(answers)
  if (keys.length !== Object.keys(questions).length || keys.some(key => !Object.hasOwn(questions, key)))
    invalidSystemOneResponse('Upstream System One response has missing or extra answers.')
  if (keys.some(key => !isPlainObject(answers[key]) || !answerSchema.safeParse(answers[key]).success))
    invalidSystemOneResponse('Upstream System One response has an invalid answer.')

  return raw as SystemOneResponse
}
