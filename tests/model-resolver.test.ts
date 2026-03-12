import { describe, expect, test } from 'bun:test'

import { DEFAULT_FALLBACKS, resolveModel } from '~/lib/model-resolver'

describe('resolveModel', () => {
  const defaultConfig = {
    claudeOpus: 'claude-opus-4.5',
    claudeSonnet: 'claude-sonnet-4.5',
    claudeHaiku: 'claude-haiku-4.5',
  }

  const knownModels = new Set(['claude-opus-4.5', 'claude-opus-4-preview'])

  test('"claude-opus-4.5" in knownModels → returns "claude-opus-4.5"', () => {
    expect(resolveModel('claude-opus-4.5', knownModels, defaultConfig)).toBe(
      'claude-opus-4.5',
    )
  })

  test('"claude-opus-4-20250514" NOT in knownModels → returns "claude-opus-4.5"', () => {
    expect(
      resolveModel('claude-opus-4-20250514', knownModels, defaultConfig),
    ).toBe('claude-opus-4.5')
  })

  test('"claude-sonnet-4-20250514" NOT in knownModels → returns "claude-sonnet-4.5"', () => {
    expect(
      resolveModel('claude-sonnet-4-20250514', knownModels, defaultConfig),
    ).toBe('claude-sonnet-4.5')
  })

  test('"claude-haiku-4-20250514" NOT in knownModels → returns "claude-haiku-4.5"', () => {
    expect(
      resolveModel('claude-haiku-4-20250514', knownModels, defaultConfig),
    ).toBe('claude-haiku-4.5')
  })

  test('"gpt-4o" NOT in knownModels → returns "gpt-4o"', () => {
    expect(resolveModel('gpt-4o', knownModels, defaultConfig)).toBe('gpt-4o')
  })

  test('knownModels undefined + "claude-opus-4-6" → returns "claude-opus-4.5"', () => {
    expect(resolveModel('claude-opus-4-6', undefined, defaultConfig)).toBe(
      'claude-opus-4.5',
    )
  })

  test('knownModels undefined + "some-random-model" → returns "some-random-model"', () => {
    expect(resolveModel('some-random-model', undefined, defaultConfig)).toBe(
      'some-random-model',
    )
  })

  test('config { claudeOpus: "custom-opus" } + "claude-opus-4-6" → returns "custom-opus"', () => {
    const customConfig = { ...defaultConfig, claudeOpus: 'custom-opus' }
    expect(resolveModel('claude-opus-4-6', knownModels, customConfig)).toBe(
      'custom-opus',
    )
  })

  test('"claude-opus-4-preview" IS in knownModels → returns "claude-opus-4-preview"', () => {
    expect(
      resolveModel('claude-opus-4-preview', knownModels, defaultConfig),
    ).toBe('claude-opus-4-preview')
  })
})

describe('DEFAULT_FALLBACKS', () => {
  test('all three tiers are defined with non-empty model IDs', () => {
    expect(DEFAULT_FALLBACKS.claudeOpus).toBeString()
    expect(DEFAULT_FALLBACKS.claudeSonnet).toBeString()
    expect(DEFAULT_FALLBACKS.claudeHaiku).toBeString()
    expect(DEFAULT_FALLBACKS.claudeOpus.length).toBeGreaterThan(0)
    expect(DEFAULT_FALLBACKS.claudeSonnet.length).toBeGreaterThan(0)
    expect(DEFAULT_FALLBACKS.claudeHaiku.length).toBeGreaterThan(0)
  })

  test('each tier maps to the correct model family prefix', () => {
    expect(DEFAULT_FALLBACKS.claudeOpus).toStartWith('claude-opus-')
    expect(DEFAULT_FALLBACKS.claudeSonnet).toStartWith('claude-sonnet-')
    expect(DEFAULT_FALLBACKS.claudeHaiku).toStartWith('claude-haiku-')
  })
})
