import type { AnthropicMessagesPayload } from '~/translator'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { applyMessagesModelPolicy, isCompactRequest } from '~/lib/request-model-policy'
import { modelCache } from '~/state'

import { buildModel, buildModelsResponse, clearConfig } from './helpers'

// ── Setup / Teardown ──

let originalModels: ReturnType<typeof modelCache.getModels>

function enableCompactRouting(smallModel: string) {
  const config = getCachedConfig() as Record<string, unknown>
  config.smallModel = smallModel
  config.compactUseSmallModel = true
}

function compactPayload(model: string): AnthropicMessagesPayload {
  return {
    model,
    max_tokens: 1024,
    system: 'You are a helpful AI assistant tasked with summarizing conversations for context.',
    messages: [{ role: 'user', content: 'Summarize the conversation so far.' }],
  } as AnthropicMessagesPayload
}

beforeEach(() => {
  originalModels = modelCache.getModels()
  modelCache.cacheModels(buildModelsResponse(
    buildModel('claude-opus-4.6'),
    buildModel('claude-opus-4.7'),
    buildModel('claude-sonnet-4.5'),
    buildModel('gpt-4.1-mini', { vendor: 'openai' }),
  ))
  clearConfig()
})

afterEach(() => {
  if (originalModels !== undefined) {
    modelCache.cacheModels(originalModels)
  }
  else {
    modelCache.clearModels()
  }
  clearConfig()
})

// ── isCompactRequest ──

describe('isCompactRequest', () => {
  test('detects compact system prompt string', () => {
    const payload = compactPayload('claude-opus-4.6')
    expect(isCompactRequest(payload)).toBe(true)
  })

  test('rejects non-compact system prompt', () => {
    const payload = {
      model: 'claude-opus-4.6',
      max_tokens: 1024,
      system: 'You are a coding assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    } as AnthropicMessagesPayload
    expect(isCompactRequest(payload)).toBe(false)
  })
})

// ── applyMessagesModelPolicy — betaUpgraded ──

describe('applyMessagesModelPolicy — betaUpgraded', () => {
  test('skips compact routing when betaUpgraded is true', () => {
    enableCompactRouting('gpt-4.1-mini')

    const payload = compactPayload('claude-opus-4.7')
    const result = applyMessagesModelPolicy(payload, { betaUpgraded: true })

    expect(result.routedModel).toBe('claude-opus-4.7')
    expect(result.reason).toBeUndefined()
    expect(payload.model).toBe('claude-opus-4.7')
  })

  test('compact routing still works when betaUpgraded is false', () => {
    enableCompactRouting('gpt-4.1-mini')

    const payload = compactPayload('claude-opus-4.6')
    const result = applyMessagesModelPolicy(payload, { betaUpgraded: false })

    expect(result.routedModel).toBe('gpt-4.1-mini')
    expect(result.reason).toBe('compact')
  })

  test('compact routing works when no options provided', () => {
    enableCompactRouting('gpt-4.1-mini')

    const payload = compactPayload('claude-opus-4.6')
    const result = applyMessagesModelPolicy(payload)

    expect(result.routedModel).toBe('gpt-4.1-mini')
    expect(result.reason).toBe('compact')
  })
})
