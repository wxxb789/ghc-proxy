import { describe, expect, test } from 'bun:test'

import { parseDecisionsRequest } from '~/ingest/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
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
