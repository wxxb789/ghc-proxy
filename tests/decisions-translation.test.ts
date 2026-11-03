import { describe, expect, test } from 'bun:test'

import { parseDecisionsRequest } from '~/ingest/validation'
import { HTTPError } from '~/lib/error'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { normalizeDecisionsUpstreamError } from '~/translator/decisions/errors'
import { translateDecisionsRequest } from '~/translator/decisions/openai-to-systemone'
import { assertDecisionsRequestSupported } from '~/translator/decisions/policy'
import { translateDecisionsResponse } from '~/translator/decisions/systemone-to-openai'

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

  test('uses synthetic index choice keys and preserves descriptions', () => {
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
      criteria: {
        c0: '"billing": Billing issues',
        c1: '"technical"',
      },
    })
    expect(translated.questions[0].choiceValues).toEqual([
      { key: 'c0', value: 'billing' },
      { key: 'c1', value: 'technical' },
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

  test('round-trips prototype-like choice values through index keys', () => {
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
    expect(Object.hasOwn(criteria, 'c0')).toBe(true)
    expect(Object.hasOwn(criteria, 'c1')).toBe(true)
    expect(Object.hasOwn(criteria, 'c2')).toBe(true)
    expect(translated.questions[0].choiceValues).toEqual([
      { key: 'c0', value: '__proto__' },
      { key: 'c1', value: 'constructor' },
      { key: 'c2', value: 'safe' },
    ])

    const response = {
      model: 'microsoft-decision-1',
      answers: {
        q0: {
          type: 'choice',
          choice: 'c0',
          confidence: 0.9,
          probabilities: { c0: 0.9, c1: 0.05, c2: 0.05 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const translatedResponse = translateDecisionsResponse(response, translated)

    expect(translatedResponse.answers[0]).toMatchObject({
      type: 'choice',
      name: null,
      choice: '__proto__',
      confidence: 0.9,
      probabilities: [
        { value: '__proto__', probability: 0.9 },
        { value: 'constructor', probability: 0.05 },
        { value: 'safe', probability: 0.05 },
      ],
    })
  })
})

describe('Decisions response translation', () => {
  function threeQuestionTranslation() {
    return translateDecisionsRequest(parseDecisionsRequest(decisionsRequest({
      questions: [
        { type: 'predicate', name: 'refund', instructions: 'Is it a refund?' },
        {
          type: 'choice',
          name: 'team',
          instructions: 'Which team?',
          choices: [{ value: true }, { value: false }],
        },
        {
          type: 'score',
          name: 'urgency',
          instructions: 'How urgent?',
          levels: [{ label: 'low' }, { label: 'high' }],
        },
      ],
    })))
  }

  function validResponse() {
    return {
      model: 'actual-decision-1',
      answers: {
        q0: { type: 'noul', noul: 0.9 },
        q1: {
          type: 'choice',
          choice: 'c1',
          confidence: 0.8,
          probabilities: { c0: 0.2, c1: 0.8 },
        },
        q2: {
          type: 'score',
          score: 1.1,
          confidence: 0.7,
          legend: {},
          probabilities: { 0: 0.1, 1: 0.9 },
        },
      },
      usage: { input_tokens: 12, output_tokens: 3 },
    }
  }

  test('maps answers in request order with typed choices and labels', () => {
    const translated = translateDecisionsResponse(validResponse(), threeQuestionTranslation())

    expect(translated.model).toBe('actual-decision-1')
    expect(translated.answers).toEqual([
      { type: 'predicate', name: 'refund', probability: 0.9 },
      {
        type: 'choice',
        name: 'team',
        choice: false,
        confidence: 0.8,
        probabilities: [
          { value: true, probability: 0.2 },
          { value: false, probability: 0.8 },
        ],
      },
      {
        type: 'score',
        name: 'urgency',
        score: 1.1,
        confidence: 0.7,
        probabilities: [
          { value: 0, label: 'low', probability: 0.1 },
          { value: 1, label: 'high', probability: 0.9 },
        ],
      },
    ])
    expect(translated.usage).toEqual({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    })
  })

  test('returns null for an unnamed question', () => {
    const translated = translateDecisionsResponse({
      model: 'actual-decision-1',
      answers: { q0: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }, translateDecisionsRequest(parseDecisionsRequest(decisionsRequest({
      questions: [{ type: 'predicate', instructions: 'Is it?' }],
    }))))

    expect(translated.answers[0]).toEqual({ type: 'predicate', name: null, probability: 0.5 })
  })

  test('maps an explicit refusal and never invents one', () => {
    const translation = threeQuestionTranslation()
    const response = validResponse() as Record<string, unknown>
    const answers = response.answers as Record<string, unknown>
    answers.q0 = { type: 'refusal' }
    const translated = translateDecisionsResponse(response, translation)
    expect(translated.answers[0]).toEqual({ type: 'refusal', name: 'refund' })

    delete answers.q0
    expect(() => translateDecisionsResponse(response, translation)).toThrow(TranslationFailure)
  })

  test('rejects missing, extra, and mismatched answers', () => {
    const translation = threeQuestionTranslation()
    const response = validResponse() as Record<string, unknown>
    const answers = response.answers as Record<string, unknown>
    answers.extra = { type: 'noul', noul: 0.5 }
    expect(() => translateDecisionsResponse(response, translation)).toThrow(TranslationFailure)

    delete answers.extra
    answers.q1 = { type: 'choice', choice: 'c9', confidence: 0.8, probabilities: { c0: 0.2, c1: 0.8 } }
    expect(() => translateDecisionsResponse(response, translation)).toThrow(TranslationFailure)
  })

  test('rejects out-of-range probabilities', () => {
    const translation = threeQuestionTranslation()
    const response = validResponse() as Record<string, unknown>
    const answers = response.answers as Record<string, unknown>
    answers.q0 = { type: 'noul', noul: 1.5 }
    expect(() => translateDecisionsResponse(response, translation)).toThrow(TranslationFailure)
  })

  test('rejects malformed usage on an otherwise valid response', () => {
    const translation = threeQuestionTranslation()
    const response = validResponse() as Record<string, unknown>
    const usage = response.usage as Record<string, unknown>
    usage.input_tokens = -1
    expect(() => translateDecisionsResponse(response, translation)).toThrow(TranslationFailure)
  })

  test('normalizes a 422 detail array with public paths and no evidence', async () => {
    const translation = threeQuestionTranslation()
    const response = new Response(JSON.stringify({
      detail: [{
        loc: ['body', 'questions', 'q1', 'criteria', 'c1'],
        msg: 'invalid choice',
        type: 'value_error',
        input: 'SENSITIVE-EVIDENCE',
      }],
    }), {
      status: 422,
      headers: { 'retry-after': '7' },
    })

    const error = await normalizeDecisionsUpstreamError('fallback', response, translation.questions)

    expect(error).toBeInstanceOf(HTTPError)
    expect(error.status).toBe(422)
    expect(error.body.error.type).toBe('invalid_request_error')
    expect(error.body.error.param).toBe('questions[1].choices[1]')
    expect(error.body.error.code).toBe('upstream_validation_error')
    expect(error.body.error.details?.[0]?.path).toBe('questions[1].choices[1]')
    expect(error.headers.get('retry-after')).toBe('7')
    expect(JSON.stringify(error.body)).not.toContain('SENSITIVE-EVIDENCE')
  })

  test('normalizes detail strings and structured errors', async () => {
    const detailError = await normalizeDecisionsUpstreamError('fallback', new Response(
      JSON.stringify({ detail: 'model refused the request' }),
      { status: 400 },
    ))
    expect(detailError.status).toBe(400)
    expect(detailError.body.error.message).toBe('model refused the request')

    const structuredError = await normalizeDecisionsUpstreamError('fallback', new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429, headers: { 'retry-after': '3' } },
    ))
    expect(structuredError.status).toBe(429)
    expect(structuredError.body.error.type).toBe('rate_limit_error')
    expect(structuredError.headers.get('retry-after')).toBe('3')
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
