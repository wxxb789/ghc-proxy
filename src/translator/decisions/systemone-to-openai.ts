import type { DecisionsQuestionMapping, DecisionsTranslationResult } from './mapping'
import type {
  DecisionsAnswer,
  DecisionsResponse,
  DecisionsUsage,
  SystemOneAnswer,
} from '~/types'

import { z } from 'zod'

import { TranslationFailure } from '~/translator/anthropic/translation-issue'

const probabilitySchema = z.number().finite().min(0).max(1)
const countSchema = z.number().int().nonnegative()
const optionalCountSchema = countSchema.optional()

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: probabilitySchema,
}).loose()

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: probabilitySchema,
  probabilities: z.record(z.string(), probabilitySchema),
}).loose()

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number().finite(),
  confidence: probabilitySchema,
  legend: z.record(z.string(), z.unknown()),
  probabilities: z.record(z.string(), probabilitySchema),
}).loose()

const boxAnswerSchema = z.object({
  type: z.literal('box'),
  box: z.object({
    top: z.number().finite(),
    bottom: z.number().finite(),
    left: z.number().finite(),
    right: z.number().finite(),
  }).strict(),
  confidence: z.number().finite().nullable(),
}).loose()

const refusalAnswerSchema = z.object({
  type: z.literal('refusal'),
}).loose()

const answerSchema = z.discriminatedUnion('type', [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
  boxAnswerSchema,
  refusalAnswerSchema,
])

const usageSchema = z.object({
  input_tokens: countSchema,
  output_tokens: countSchema,
  cached_tokens: optionalCountSchema,
  cache_write_tokens: optionalCountSchema,
  reasoning_tokens: optionalCountSchema,
}).loose()

const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: usageSchema,
}).loose()

type ParsedUsage = z.infer<typeof usageSchema>

function invalidResponse(message: string): never {
  throw new TranslationFailure(message, {
    status: 502,
    kind: 'invalid_upstream_decisions_response',
  })
}

function translateUsage(usage: ParsedUsage): DecisionsUsage {
  return {
    input_tokens: usage.input_tokens,
    input_tokens_details: {
      cached_tokens: usage.cached_tokens ?? 0,
      cache_write_tokens: usage.cache_write_tokens ?? 0,
    },
    output_tokens: usage.output_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.reasoning_tokens ?? 0,
    },
    total_tokens: usage.input_tokens + usage.output_tokens,
  }
}

function translatePredicateAnswer(
  answer: SystemOneAnswer,
  mapping: DecisionsQuestionMapping,
  questionIndex: number,
): DecisionsAnswer {
  if (answer.type !== 'noul')
    invalidResponse(`Upstream answer for questions[${questionIndex}] is not a predicate answer.`)

  return {
    type: 'predicate',
    name: mapping.name,
    probability: answer.noul,
  }
}

function translateChoiceAnswer(
  answer: SystemOneAnswer,
  mapping: DecisionsQuestionMapping,
  questionIndex: number,
): DecisionsAnswer {
  if (answer.type !== 'choice')
    invalidResponse(`Upstream answer for questions[${questionIndex}] is not a choice answer.`)

  const choiceValues = mapping.choiceValues ?? []
  const keys = choiceValues.map(choice => choice.key)
  const answeredKeys = Object.keys(answer.probabilities)

  if (
    answeredKeys.length !== keys.length
    || answeredKeys.some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(answer.probabilities, key))
  ) {
    invalidResponse(`Upstream choice answer for ${mapping.key} has mismatched probabilities.`)
  }

  const selected = choiceValues.find(choice => choice.key === answer.choice)
  if (!selected)
    invalidResponse(`Upstream choice answer for ${mapping.key} selected an unknown choice.`)

  return {
    type: 'choice',
    name: mapping.name,
    choice: selected.value,
    confidence: answer.confidence,
    probabilities: choiceValues.map(choice => ({
      value: choice.value,
      probability: answer.probabilities[choice.key],
    })),
  }
}

function translateScoreAnswer(
  answer: SystemOneAnswer,
  mapping: DecisionsQuestionMapping,
  questionIndex: number,
): DecisionsAnswer {
  if (answer.type !== 'score')
    invalidResponse(`Upstream answer for questions[${questionIndex}] is not a score answer.`)

  const labels = mapping.scoreLabels ?? []
  const expectedKeys = labels.map((_, index) => String(index))
  const answeredKeys = Object.keys(answer.probabilities)

  if (
    answeredKeys.length !== expectedKeys.length
    || answeredKeys.some(key => !expectedKeys.includes(key))
  ) {
    invalidResponse(`Upstream score answer for questions[${questionIndex}] has mismatched probabilities.`)
  }

  return {
    type: 'score',
    name: mapping.name,
    score: answer.score,
    confidence: answer.confidence,
    probabilities: labels.map((label, index) => ({
      value: index,
      label,
      probability: answer.probabilities[String(index)],
    })),
  }
}

function translateAnswer(
  answer: SystemOneAnswer,
  mapping: DecisionsQuestionMapping,
  questionIndex: number,
): DecisionsAnswer {
  if (answer.type === 'refusal')
    return { type: 'refusal', name: mapping.name }

  switch (mapping.kind) {
    case 'predicate':
      return translatePredicateAnswer(answer, mapping, questionIndex)
    case 'choice':
      return translateChoiceAnswer(answer, mapping, questionIndex)
    case 'score':
      return translateScoreAnswer(answer, mapping, questionIndex)
  }
}

export function translateDecisionsResponse(
  value: unknown,
  translation: DecisionsTranslationResult,
): DecisionsResponse {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success)
    invalidResponse('Upstream decisions response has an invalid shape.')

  const response = parsed.data
  const expectedKeys = translation.questions.map(question => question.key)
  const answeredKeys = Object.keys(response.answers)

  if (
    answeredKeys.length !== expectedKeys.length
    || answeredKeys.some(key => !expectedKeys.includes(key))
  ) {
    invalidResponse('Upstream decisions response has missing or extra answers.')
  }

  const answers = translation.questions.map((mapping, index) => {
    const answer = response.answers[mapping.key] as SystemOneAnswer | undefined
    if (!answer)
      invalidResponse(`Upstream decisions response is missing the answer for questions[${index}].`)
    return translateAnswer(answer, mapping, index)
  })

  return {
    answers,
    model: response.model,
    usage: translateUsage(response.usage),
  }
}
