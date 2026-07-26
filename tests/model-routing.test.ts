import type { ModelMappingInfo } from '~/lib/request-logger'
import type { AnthropicMessagesPayload } from '~/translator'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { DEFAULT_FALLBACKS, resolveModel } from '~/lib/model-resolver'
import { appendModelStepInPlace, getEffectiveModel, logRequest } from '~/lib/request-logger'
import { modelCache } from '~/state'
import { rewriteModel } from '~/transform/model-rewrite'
import { applyMessagesModelPolicy, isCompactRequest } from '~/transform/request-model-policy'

import { buildModel, buildModelsResponse, clearConfig } from './helpers'

// ── resolveModel — pure fallback resolution (no shared state) ──

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

// ── rewriteModel — model cache + config-rule driven (scoped state) ──

describe('rewriteModel', () => {
  let originalModels: ReturnType<typeof modelCache.getModels>

  function setModelRewrites(rules: Array<{ from: string, to: string }>) {
    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = rules
  }

  beforeEach(() => {
    originalModels = modelCache.getModels()
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-opus-4.6'),
      buildModel('claude-opus-4.7'),
      buildModel('claude-sonnet-4.5'),
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

  describe('normalization', () => {
    test('exact match passes through unchanged', () => {
      const result = rewriteModel('claude-opus-4.6')
      expect(result.model).toBe('claude-opus-4.6')
      expect(result.originalModel).toBe('claude-opus-4.6')
      expect(result.model).toBe(result.originalModel)
    })

    test('normalizes dashes to dots when model exists', () => {
      const result = rewriteModel('claude-opus-4-6')
      expect(result.model).toBe('claude-opus-4.6')
      expect(result.originalModel).toBe('claude-opus-4-6')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('normalizes dashes to dots for multi-segment version', () => {
      const result = rewriteModel('claude-opus-4-7')
      expect(result.model).toBe('claude-opus-4.7')
      expect(result.originalModel).toBe('claude-opus-4-7')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('unknown model passes through unchanged', () => {
      const result = rewriteModel('gpt-5.4')
      expect(result.model).toBe('gpt-5.4')
      expect(result.originalModel).toBe('gpt-5.4')
      expect(result.model).toBe(result.originalModel)
    })

    test('no cached models — passes through unchanged', () => {
      modelCache.clearModels()
      const result = rewriteModel('claude-opus-4-6')
      expect(result.model).toBe('claude-opus-4-6')
      expect(result.model).toBe(result.originalModel)
    })
  })

  describe('user rules', () => {
    test('exact match user rule', () => {
      setModelRewrites([{ from: 'my-model', to: 'claude-opus-4.6' }])

      const result = rewriteModel('my-model')
      expect(result.model).toBe('claude-opus-4.6')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('glob pattern user rule', () => {
      setModelRewrites([{ from: 'claude-opus-*', to: 'gpt-5.4' }])

      const result = rewriteModel('claude-opus-4.6')
      expect(result.model).toBe('gpt-5.4')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('user rules take priority over built-in normalization', () => {
      setModelRewrites([{ from: 'claude-opus-4-6', to: 'custom-model' }])

      const result = rewriteModel('claude-opus-4-6')
      expect(result.model).toBe('custom-model')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('first match wins', () => {
      setModelRewrites([
        { from: 'claude-opus-*', to: 'first-match' },
        { from: 'claude-opus-4.6', to: 'second-match' },
      ])

      const result = rewriteModel('claude-opus-4.6')
      expect(result.model).toBe('first-match')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('non-matching user rules fall through to normalization', () => {
      setModelRewrites([{ from: 'gpt-*', to: 'something' }])

      const result = rewriteModel('claude-opus-4-6')
      expect(result.model).toBe('claude-opus-4.6')
      expect(result.model).not.toBe(result.originalModel)
    })

    test('normalizes user rule target with dash/dot equivalence', () => {
      setModelRewrites([{ from: 'my-model', to: 'claude-opus-4-7' }])

      const result = rewriteModel('my-model')
      expect(result.model).toBe('claude-opus-4.7')
      expect(result.originalModel).toBe('my-model')
    })

    test('preserves user rule target when not in models list', () => {
      setModelRewrites([{ from: 'my-model', to: 'unknown-model' }])

      const result = rewriteModel('my-model')
      expect(result.model).toBe('unknown-model')
      expect(result.originalModel).toBe('my-model')
    })
  })
})

// ── request model policy — compact detection + small-model routing ──

describe('request model policy', () => {
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
})

// ── Model trace rendering — the ONLY user-visible output of the transform chain ──
//
// The trace is printed to stdout on every request (src/server.ts onAfterResponse
// -> logRequest -> formatModelMapping). Nothing else in the suite asserts on it,
// so a refactor that drops a tag or reorders the chain would be invisible.
// These tests lock the rendered shape.

// Built from a char code so the source carries no literal control character.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g')

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '')
}

/** Capture the single line logRequest writes to stdout, with colors stripped. */
function captureLogLine(modelInfo?: ModelMappingInfo): string {
  const lines: Array<string> = []
  // eslint-disable-next-line no-console
  const originalLog = console.log
  // eslint-disable-next-line no-console
  console.log = ((...args: Array<unknown>) => {
    lines.push(args.map(String).join(' '))
  }) as typeof console.log

  try {
    logRequest('POST', 'http://localhost/v1/messages', 200, '1ms', modelInfo)
  }
  finally {
    // eslint-disable-next-line no-console
    console.log = originalLog
  }

  expect(lines).toHaveLength(1)
  return stripAnsi(lines[0]!)
}

describe('model trace rendering', () => {
  test('renders no model segment when there is no mapping', () => {
    expect(captureLogLine()).not.toContain('model=')
  })

  test('renders no model segment for an empty mapping', () => {
    expect(captureLogLine({ steps: [] })).not.toContain('model=')
  })

  test('renders the original model alone when no steps ran', () => {
    const line = captureLogLine({ originalModel: 'claude-opus-4.6', steps: [] })

    expect(line).toContain('model=claude-opus-4.6')
    expect(line).not.toContain('->')
  })

  test('renders a single step as original -[TAG]-> target', () => {
    const line = captureLogLine({
      originalModel: 'claude-opus-4.6',
      steps: [{ tag: 'CONFIG_REWRITE', from: 'claude-opus-4.6', to: 'claude-opus-5' }],
    })

    expect(line).toContain('model=claude-opus-4.6 -[CONFIG_REWRITE]-> claude-opus-5')
  })

  test('renders every tag in a multi-step chain, in order', () => {
    const line = captureLogLine({
      originalModel: 'claude-opus-4.9',
      steps: [
        { tag: 'AUTO_CORRECT', from: 'claude-opus-4.9', to: 'claude-opus-4-9' },
        { tag: 'COMPACT', from: 'claude-opus-4-9', to: 'gpt-4.1-mini' },
        { tag: 'MODEL_RESOLVE', from: 'gpt-4.1-mini', to: 'gpt-4.1-mini-2025' },
      ],
    })

    expect(line).toContain(
      'model=claude-opus-4.9'
      + ' -[AUTO_CORRECT]-> claude-opus-4-9'
      + ' -[COMPACT]-> gpt-4.1-mini'
      + ' -[MODEL_RESOLVE]-> gpt-4.1-mini-2025',
    )
  })

  test('getEffectiveModel reports the last hop, or the original when no steps ran', () => {
    expect(getEffectiveModel({ originalModel: 'a', steps: [] })).toBe('a')
    expect(getEffectiveModel({
      originalModel: 'a',
      steps: [{ tag: 'CONFIG_REWRITE', from: 'a', to: 'b' }],
    })).toBe('b')
  })

  test('appendModelStepInPlace appends only when the model actually changed', () => {
    const info: ModelMappingInfo = { originalModel: 'a', steps: [] }

    appendModelStepInPlace(info, 'MODEL_RESOLVE', 'a')
    expect(info.steps).toHaveLength(0)

    appendModelStepInPlace(info, 'MODEL_RESOLVE', 'b')
    expect(info.steps).toEqual([{ tag: 'MODEL_RESOLVE', from: 'a', to: 'b' }])
  })
})
