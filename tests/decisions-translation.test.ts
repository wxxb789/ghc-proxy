import { describe, expect, test } from 'bun:test'

import { parseDecisionsRequest } from '~/ingest/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateDecisionsRequest } from '~/translator/decisions/openai-to-systemone'
import { assertDecisionsRequestSupported } from '~/translator/decisions/policy'

function decisionsRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: 'microsoft-decision-1',
    input: 'Customer wants a refund.',
    questions: [{ type: 'predicate', instructions: 'Is the customer asking for a refund?' }],
    ...overrides,
  }
}

function expectUnsupported(payload: unknown, kind: string) {
  const parsed = parseDecisionsRequest(payload)
  try {
    assertDecisionsRequestSupported(parsed)
  }
  catch (error) {
    expect(error).toBeInstanceOf(TranslationFailure)
    const failure = error as TranslationFailure
    expect(failure.status).toBe(400)
    expect(failure.kind).toBe(kind)
    return
  }

  throw new Error(`Expected ${kind} to be rejected`)
}

describe('Decisions request translation', () => {
  function translate(overrides: Record<string, unknown> = {}) {
    return translateDecisionsRequest(parseDecisionsRequest(decisionsRequest(overrides)))
  }

  test('maps string input to a string state', () => {
    const translated = translate({ input: 'hello' })

    expect(translated.upstream.state).toBe('hello')
    expect(translated.upstream.model).toBe('microsoft-decision-1')
  })

  test('preserves message order, roles, and part boundaries', () => {
    const translated = translate({
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello' },
            { type: 'input_json', data: { ticket: 1 } },
          ],
        },
        { role: 'assistant', content: [{ type: 'output_text', text: 'prior answer' }] },
      ],
    })

    expect(translated.upstream.state).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_json', data: { ticket: 1 } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'prior answer' }],
      },
    ])
  })

  test('maps a predicate to noul with an internal key', () => {
    const translated = translate({
      questions: [{ type: 'predicate', name: 'refund', instructions: 'Is it a refund?' }],
    })

    expect(translated.upstream.questions).toEqual({
      q0: { type: 'noul', instructions: 'Is it a refund?' },
    })
    expect(translated.questions[0]).toEqual({
      key: 'q0',
      name: 'refund',
      kind: 'predicate',
    })
  })

  test('uses natural string choice keys and preserves omitted descriptions', () => {
    const translated = translate({
      questions: [{
        type: 'choice',
        instructions: 'Which team?',
        choices: [
          { value: 'billing', description: 'Billing issues' },
          { value: 'technical' },
        ],
      }],
    })

    expect(translated.upstream.questions.q0).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Billing issues', technical: null },
    })
    expect(translated.questions[0].choiceValues).toEqual([
      { key: 'billing', value: 'billing' },
      { key: 'technical', value: 'technical' },
    ])
  })

  test('uses index keys for boolean choices and preserves typed values', () => {
    const translated = translate({
      questions: [{
        type: 'choice',
        instructions: 'Yes or no?',
        choices: [{ value: true }, { value: false }],
      }],
    })

    expect(translated.upstream.questions.q0).toEqual({
      type: 'choice',
      instructions: 'Yes or no?',
      criteria: { c0: 'true', c1: 'false' },
    })
    expect(translated.questions[0].choiceValues).toEqual([
      { key: 'c0', value: true },
      { key: 'c1', value: false },
    ])
  })

  test('keeps a boolean and its string spelling distinct', () => {
    const translated = translate({
      questions: [{
        type: 'choice',
        instructions: 'Pick one.',
        choices: [{ value: true }, { value: 'true' }, { value: 'other' }],
      }],
    })

    expect(translated.upstream.questions.q0).toEqual({
      type: 'choice',
      instructions: 'Pick one.',
      criteria: { c0: 'true', c1: '"true"', c2: '"other"' },
    })
    expect(translated.questions[0].choiceValues).toEqual([
      { key: 'c0', value: true },
      { key: 'c1', value: 'true' },
      { key: 'c2', value: 'other' },
    ])
  })

  test('rejects duplicate typed choice values', () => {
    expect(() => translate({
      questions: [{
        type: 'choice',
        instructions: 'Pick one.',
        choices: [{ value: true }, { value: true }],
      }],
    })).toThrow(TranslationFailure)
  })

  test('preserves score labels, order, and explicit empty descriptions', () => {
    const translated = translate({
      questions: [{
        type: 'score',
        instructions: 'Rate it.',
        levels: [
          { label: 'calm' },
          { label: '', description: '' },
          { label: 'angry', description: 'hostile' },
        ],
      }],
    })

    expect(translated.upstream.questions.q0).toEqual({
      type: 'score',
      instructions: 'Rate it.',
      criteria: ['calm', ': ', 'angry: hostile'],
    })
    expect(translated.questions[0].scoreLabels).toEqual(['calm', '', 'angry'])
  })

  test('uses index keys for unnamed and duplicate names', () => {
    const translated = translate({
      questions: [
        { type: 'predicate', instructions: 'One?' },
        { type: 'predicate', name: '', instructions: 'Two?' },
        { type: 'predicate', name: 'same', instructions: 'Three?' },
        { type: 'predicate', name: 'same', instructions: 'Four?' },
      ],
    })

    expect(translated.questions.map(question => question.key)).toEqual(['q0', 'q1', 'q2', 'q3'])
    expect(translated.questions.map(question => question.name)).toEqual([null, '', 'same', 'same'])
  })

  test('renders question instruction parts deterministically', () => {
    const translated = translate({
      questions: [{
        type: 'predicate',
        instructions: [
          { type: 'input_text', text: 'First' },
          { type: 'input_json', data: { ticket: 1 } },
          { type: 'input_text', text: 'Last' },
        ],
      }],
    })

    expect(translated.upstream.questions.q0).toEqual({
      type: 'noul',
      instructions: 'First\n\n{"ticket":1}\n\nLast',
    })
  })

  test('keeps prototype-like choice values as ordinary data', () => {
    const translated = translate({
      questions: [{
        type: 'choice',
        instructions: 'Pick one.',
        choices: [{ value: '__proto__' }, { value: 'constructor' }, { value: 'safe' }],
      }],
    })

    const question = translated.upstream.questions.q0
    expect(question?.type).toBe('choice')
    if (question?.type !== 'choice')
      throw new Error('Expected a choice question')
    const criteria = question.criteria
    expect(Object.hasOwn(criteria, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(criteria, '__proto__')?.value).toBeNull()
    expect(criteria.constructor).toBeNull()
    expect(criteria.safe).toBeNull()
    expect(translated.questions[0].choiceValues).toEqual([
      { key: '__proto__', value: '__proto__' },
      { key: 'constructor', value: 'constructor' },
      { key: 'safe', value: 'safe' },
    ])
  })
})

describe('Decisions field policy', () => {
  test('rejects optional fields with no System One equivalent', () => {
    expectUnsupported(decisionsRequest({ safety_identifier: 'user-1' }), 'unsupported_decisions_safety_identifier')
    expectUnsupported(decisionsRequest({ prompt_cache_key: 'key' }), 'unsupported_decisions_prompt_cache_key')
    expectUnsupported(decisionsRequest({ prompt_cache_options: { mode: 'explicit' } }), 'unsupported_decisions_prompt_cache_options')
  })

  test('rejects image parts in messages and question instructions', () => {
    expectUnsupported(decisionsRequest({
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
      }],
    }), 'unsupported_decisions_image')

    expectUnsupported(decisionsRequest({
      questions: [{
        type: 'predicate',
        instructions: [{ type: 'input_image', image_url: 'https://example.com/image.png' }],
      }],
    }), 'unsupported_decisions_image')
  })

  test('rejects tool-call evidence', () => {
    expectUnsupported(decisionsRequest({
      input: [{
        type: 'function_call',
        arguments: '{}',
        call_id: 'call-1',
        name: 'lookup',
      }],
    }), 'unsupported_decisions_tool_item')
  })

  test('rejects assistant refusals and message phases', () => {
    expectUnsupported(decisionsRequest({
      input: [{
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot answer.' }],
      }],
    }), 'unsupported_decisions_assistant_refusal')

    expectUnsupported(decisionsRequest({
      input: [{
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Prior answer' }],
        phase: 'final_answer',
      }],
    }), 'unsupported_decisions_message_phase')
  })

  test('rejects JSON evidence outside user messages', () => {
    expectUnsupported(decisionsRequest({
      input: [{
        role: 'developer',
        content: [{ type: 'input_json', data: { ticket: 1 } }],
      }],
    }), 'unsupported_decisions_json_role')

    expectUnsupported(decisionsRequest({
      input: [{
        role: 'assistant',
        content: [{ type: 'input_json', data: { ticket: 1 } }],
      }],
    }), 'unsupported_decisions_json_role')
  })

  test('rejects prompt cache breakpoints', () => {
    expectUnsupported(decisionsRequest({
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'hello',
          prompt_cache_breakpoint: { mode: 'explicit' },
        }],
      }],
    }), 'unsupported_decisions_prompt_cache_breakpoint')
  })

  test('accepts assistant output text and user JSON evidence', () => {
    const parsed = parseDecisionsRequest(decisionsRequest({
      input: [
        { role: 'user', content: [{ type: 'input_json', data: { ticket: 1 } }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Prior answer' }] },
      ],
    }))

    expect(() => assertDecisionsRequestSupported(parsed)).not.toThrow()
  })

  test('accepts empty evidence and unnamed questions', () => {
    const parsed = parseDecisionsRequest(decisionsRequest({
      input: '',
      questions: [{ type: 'predicate', name: '', instructions: '' }],
    }))

    expect(() => assertDecisionsRequestSupported(parsed)).not.toThrow()
  })
})
