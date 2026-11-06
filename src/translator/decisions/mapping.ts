import type {
  DecisionsChoiceQuestion,
  DecisionsInputItem,
  DecisionsInputPart,
  DecisionsMessage,
  DecisionsQuestion,
  DecisionsRequest,
  DecisionsScoreQuestion,
  SystemOneChoiceQuestion,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneState,
} from '~/types'

import { TranslationFailure } from '~/translator/anthropic/translation-issue'

export interface DecisionsChoiceMapping {
  key: string
  value: string | boolean
}

export interface DecisionsQuestionMapping {
  key: string
  name: string | null
  kind: DecisionsQuestion['type']
  choiceValues?: Array<DecisionsChoiceMapping>
  scoreLabels?: Array<string>
}

export interface DecisionsTranslationResult {
  upstream: SystemOneRequest
  questions: Array<DecisionsQuestionMapping>
}

function unsupportedInput(message: string): never {
  throw new TranslationFailure(message, { status: 400, kind: 'unsupported_decisions_input_item' })
}

function isMessage(item: DecisionsInputItem): item is DecisionsMessage {
  return 'role' in item && 'content' in item
}

function normalizePart(part: DecisionsInputPart): unknown {
  if (part.type === 'input_image') {
    unsupportedInput('Image input is not supported by System One models.')
  }
  if (part.type === 'refusal') {
    unsupportedInput('Refusal evidence is not supported by System One models.')
  }
  if (part.type === 'input_json') {
    return { type: 'input_json', data: part.data }
  }
  return { type: part.type, text: part.text }
}

function normalizeInputItem(item: DecisionsInputItem): unknown {
  if (!isMessage(item)) {
    unsupportedInput('Tool-call evidence is not supported by System One models.')
  }

  return {
    role: item.role,
    content: typeof item.content === 'string'
      ? item.content
      : item.content.map(normalizePart),
  }
}

function translateState(input: DecisionsRequest['input']): SystemOneState {
  if (typeof input === 'string')
    return input

  return input.map(normalizeInputItem)
}

function renderInstructions(
  instructions: DecisionsQuestion['instructions'],
): string {
  if (typeof instructions === 'string')
    return instructions

  return instructions
    .map((part) => {
      if (part.type === 'input_json')
        return JSON.stringify(part.data)
      if (part.type === 'input_image')
        unsupportedInput('Image input is not supported by System One models.')
      return part.text
    })
    .join('\n\n')
}

function translatePredicateQuestion(
  question: Extract<DecisionsQuestion, { type: 'predicate' }>,
  key: string,
): { systemOne: SystemOneQuestion, mapping: DecisionsQuestionMapping } {
  return {
    systemOne: {
      type: 'noul',
      instructions: renderInstructions(question.instructions),
    },
    mapping: {
      key,
      name: question.name ?? null,
      kind: 'predicate',
    },
  }
}

function translateChoiceQuestion(
  question: DecisionsChoiceQuestion,
  key: string,
): { systemOne: SystemOneQuestion, mapping: DecisionsQuestionMapping } {
  // `c{index}` keys are deliberately synthetic for every choice. Arbitrary
  // user strings (including `__proto__`) must round-trip through
  // `probabilities` records, and Zod's record parser drops prototype-like own
  // keys, so a "natural" value key would turn a complete valid response into
  // a false 502. The original value stays recoverable through `choiceValues`.
  const criteria = new Map<string, string | null>()
  const choiceValues: Array<DecisionsChoiceMapping> = []

  question.choices.forEach((choice, index) => {
    const choiceKey = `c${index}`
    const label = typeof choice.value === 'boolean'
      ? String(choice.value)
      : JSON.stringify(choice.value)
    const description = choice.description === undefined
      ? label
      : `${label}: ${choice.description}`

    criteria.set(choiceKey, description)
    choiceValues.push({ key: choiceKey, value: choice.value })
  })

  const systemOne: SystemOneChoiceQuestion = {
    type: 'choice',
    instructions: renderInstructions(question.instructions),
    criteria: Object.fromEntries(criteria),
  }

  return {
    systemOne,
    mapping: {
      key,
      name: question.name ?? null,
      kind: 'choice',
      choiceValues,
    },
  }
}

function translateScoreQuestion(
  question: DecisionsScoreQuestion,
  key: string,
): { systemOne: SystemOneQuestion, mapping: DecisionsQuestionMapping } {
  return {
    systemOne: {
      type: 'score',
      instructions: renderInstructions(question.instructions),
      criteria: question.levels.map(level =>
        level.description === undefined ? level.label : `${level.label}: ${level.description}`,
      ),
    },
    mapping: {
      key,
      name: question.name ?? null,
      kind: 'score',
      scoreLabels: question.levels.map(level => level.label),
    },
  }
}

function translateQuestion(
  question: DecisionsQuestion,
  index: number,
): { systemOne: SystemOneQuestion, mapping: DecisionsQuestionMapping } {
  const key = `q${index}`
  switch (question.type) {
    case 'predicate':
      return translatePredicateQuestion(question, key)
    case 'choice':
      return translateChoiceQuestion(question, key)
    case 'score':
      return translateScoreQuestion(question, key)
  }
}

export function buildSystemOneRequest(payload: DecisionsRequest): DecisionsTranslationResult {
  const translated = payload.questions.map((question, index) =>
    translateQuestion(question, index),
  )

  return {
    upstream: {
      model: payload.model,
      state: translateState(payload.input),
      questions: Object.fromEntries(
        translated.map(({ systemOne, mapping }) => [mapping.key, systemOne]),
      ),
    },
    questions: translated.map(({ mapping }) => mapping),
  }
}
