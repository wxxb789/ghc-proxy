import type {
  DecisionsInputPart,
  DecisionsMessage,
  DecisionsQuestion,
  DecisionsRequest,
} from '~/types'

import { TranslationFailure } from '~/translator/anthropic/translation-issue'

function unsupported(kind: string, message: string): never {
  throw new TranslationFailure(message, { status: 400, kind })
}

function isMessage(item: object): item is DecisionsMessage {
  return 'role' in item && 'content' in item
}

function assertPartSupported(part: DecisionsInputPart, role: DecisionsMessage['role']): void {
  if (part.type === 'input_image') {
    unsupported('unsupported_decisions_image', 'Image input is not supported by this proxy.')
  }

  if (part.type === 'input_text' && part.prompt_cache_breakpoint != null) {
    unsupported(
      'unsupported_decisions_prompt_cache_breakpoint',
      'Prompt cache breakpoints are not supported by this proxy.',
    )
  }

  if (part.type === 'input_json' && role !== 'user') {
    unsupported(
      'unsupported_decisions_json_role',
      'JSON input parts are supported only on user messages.',
    )
  }

  if (role === 'assistant') {
    if (part.type === 'refusal') {
      unsupported(
        'unsupported_decisions_assistant_refusal',
        'Assistant refusal evidence is not supported by this proxy.',
      )
    }
    if (part.type !== 'output_text') {
      unsupported(
        'unsupported_decisions_assistant_content',
        'Assistant messages support only output_text content in this proxy.',
      )
    }
    return
  }

  if (part.type === 'output_text' || part.type === 'refusal') {
    unsupported(
      'unsupported_decisions_message_content',
      'Output text and refusal parts are supported only on assistant messages.',
    )
  }
}

function assertMessageSupported(message: DecisionsMessage): void {
  if (message.phase != null) {
    unsupported(
      'unsupported_decisions_message_phase',
      'Message phase is not supported by this proxy.',
    )
  }

  if (typeof message.content === 'string')
    return

  for (const part of message.content)
    assertPartSupported(part, message.role)
}

function assertQuestionSupported(question: DecisionsQuestion): void {
  if (question.type === 'choice')
    assertChoiceValuesUnique(question)

  if (typeof question.instructions === 'string')
    return

  for (const part of question.instructions) {
    if (part.type === 'input_image') {
      unsupported('unsupported_decisions_image', 'Image input is not supported by this proxy.')
    }
    if (part.type === 'input_text' && part.prompt_cache_breakpoint != null) {
      unsupported(
        'unsupported_decisions_prompt_cache_breakpoint',
        'Prompt cache breakpoints are not supported by this proxy.',
      )
    }
  }
}

/**
 * Typed-value uniqueness is part of admission, not translation: rejecting it
 * here keeps the 400 stable on a cold catalog, where a later rejection would
 * first burn a GET /models (and surface a catalog failure instead).
 */
function assertChoiceValuesUnique(question: Extract<DecisionsQuestion, { type: 'choice' }>): void {
  const seen = new Set<string>()
  for (const choice of question.choices) {
    const canonical = `${typeof choice.value}:${String(choice.value)}`
    if (seen.has(canonical))
      unsupported('invalid_decisions_choice', 'Duplicate choice values are not supported.')
    seen.add(canonical)
  }
}

/**
 * Reject every public field this proxy cannot translate losslessly. The check
 * runs before catalog loading, so an invalid request never makes an upstream
 * call of any kind.
 */
export function assertDecisionsRequestSupported(payload: DecisionsRequest): void {
  if (payload.safety_identifier != null) {
    unsupported(
      'unsupported_decisions_safety_identifier',
      'safety_identifier is not supported by this proxy.',
    )
  }
  if (payload.prompt_cache_key != null) {
    unsupported(
      'unsupported_decisions_prompt_cache_key',
      'prompt_cache_key is not supported by this proxy.',
    )
  }
  if (payload.prompt_cache_options != null) {
    unsupported(
      'unsupported_decisions_prompt_cache_options',
      'prompt_cache_options is not supported by this proxy.',
    )
  }

  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (!isMessage(item)) {
        unsupported(
          'unsupported_decisions_tool_item',
          'Tool-call and tool-output evidence is not supported by this proxy.',
        )
      }
      assertMessageSupported(item)
    }
  }

  for (const question of payload.questions)
    assertQuestionSupported(question)
}
