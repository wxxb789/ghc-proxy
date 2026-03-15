import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getContextUpgradeTarget, isContextLengthError, resolveContextUpgrade } from '~/lib/context-upgrade'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { estimateAnthropicInputTokens } from '~/lib/tokenizer'

import { buildModel, buildModelsResponse } from './helpers'

// ── Setup / Teardown ──

let originalModels: typeof state.cache.models

beforeEach(() => {
  originalModels = state.cache.models
  state.cache.models = buildModelsResponse(
    buildModel('claude-opus-4.6'),
    buildModel('claude-opus-4.6-1m'),
  )
})

afterEach(() => {
  state.cache.models = originalModels
})

// ── estimateAnthropicInputTokens ──

describe('estimateAnthropicInputTokens', () => {
  test('small payload returns reasonable token count', () => {
    const tokens = estimateAnthropicInputTokens({
      model: 'claude-opus-4.6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello world' }],
    } as any)
    // "Hello world" = 11 chars → ~4 tokens
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  test('large payload with system + messages + tools returns high count', () => {
    const longText = 'a'.repeat(700_000)
    const tokens = estimateAnthropicInputTokens({
      model: 'claude-opus-4.6',
      max_tokens: 4096,
      system: longText,
      messages: [{ role: 'user', content: 'Summarize' }],
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    } as any)
    // 700k chars / 3.5 ≈ 200k tokens
    expect(tokens).toBeGreaterThan(190_000)
  })

  test('handles array system blocks', () => {
    const tokens = estimateAnthropicInputTokens({
      model: 'claude-opus-4.6',
      max_tokens: 4096,
      system: [{ type: 'text', text: 'System prompt here' }],
      messages: [{ role: 'user', content: 'Hi' }],
    } as any)
    expect(tokens).toBeGreaterThan(0)
  })

  test('handles content blocks with tool_use and tool_result', () => {
    const tokens = estimateAnthropicInputTokens({
      model: 'claude-opus-4.6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Use the tool' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { city: 'Tokyo' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 25°C' },
          ],
        },
      ],
    } as any)
    expect(tokens).toBeGreaterThan(0)
  })

  test('handles thinking blocks', () => {
    const tokens = estimateAnthropicInputTokens({
      model: 'claude-opus-4.6',
      max_tokens: 4096,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this carefully...' },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      ],
    } as any)
    expect(tokens).toBeGreaterThan(0)
  })
})

// ── isContextLengthError ──

describe('isContextLengthError', () => {
  test('matches "context length" error', () => {
    const error = new HTTPError(400, {
      error: { message: 'The request context length exceeds the maximum', type: 'invalid_request_error' },
    })
    expect(isContextLengthError(error)).toBe(true)
  })

  test('matches "too long" error', () => {
    const error = new HTTPError(400, {
      error: { message: 'Input is too long for this model', type: 'invalid_request_error' },
    })
    expect(isContextLengthError(error)).toBe(true)
  })

  test('matches "token limit exceeded" error', () => {
    const error = new HTTPError(400, {
      error: { message: 'The number of tokens exceeded the maximum allowed', type: 'invalid_request_error' },
    })
    expect(isContextLengthError(error)).toBe(true)
  })

  test('matches "maximum token" error', () => {
    const error = new HTTPError(400, {
      error: { message: 'Exceeded maximum token count for this model', type: 'invalid_request_error' },
    })
    expect(isContextLengthError(error)).toBe(true)
  })

  test('rejects non-400 status', () => {
    const error = new HTTPError(500, {
      error: { message: 'Context length exceeded', type: 'server_error' },
    })
    expect(isContextLengthError(error)).toBe(false)
  })

  test('rejects non-HTTPError', () => {
    expect(isContextLengthError(new Error('context length exceeded'))).toBe(false)
  })

  test('rejects unrelated 400 error', () => {
    const error = new HTTPError(400, {
      error: { message: 'Invalid model specified', type: 'invalid_request_error' },
    })
    expect(isContextLengthError(error)).toBe(false)
  })
})

// ── resolveContextUpgrade ──

describe('resolveContextUpgrade', () => {
  test('upgrades claude-opus-4.6 above threshold', () => {
    expect(resolveContextUpgrade('claude-opus-4.6', 200_000)).toBe('claude-opus-4.6-1m')
  })

  test('skips below threshold', () => {
    expect(resolveContextUpgrade('claude-opus-4.6', 100_000)).toBeUndefined()
  })

  test('skips at exact threshold', () => {
    expect(resolveContextUpgrade('claude-opus-4.6', 190_000)).toBeUndefined()
  })

  test('skips unknown models', () => {
    expect(resolveContextUpgrade('claude-sonnet-4.5', 200_000)).toBeUndefined()
  })

  test('skips when target model not in models list', () => {
    state.cache.models = buildModelsResponse(buildModel('claude-opus-4.6'))
    expect(resolveContextUpgrade('claude-opus-4.6', 200_000)).toBeUndefined()
  })
})

// ── getContextUpgradeTarget ──

describe('getContextUpgradeTarget', () => {
  test('returns target for claude-opus-4.6', () => {
    expect(getContextUpgradeTarget('claude-opus-4.6')).toBe('claude-opus-4.6-1m')
  })

  test('returns undefined for unknown models', () => {
    expect(getContextUpgradeTarget('claude-sonnet-4.5')).toBeUndefined()
  })

  test('returns undefined when target not in models list', () => {
    state.cache.models = buildModelsResponse(buildModel('claude-opus-4.6'))
    expect(getContextUpgradeTarget('claude-opus-4.6')).toBeUndefined()
  })
})
