import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { rewriteModel } from '~/lib/model-rewrite'
import { modelCache } from '~/state'

import { buildModel, buildModelsResponse, clearConfig } from './helpers'

// ── Setup / Teardown ──

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

// ── rewriteModel — normalization ──

describe('rewriteModel — normalization', () => {
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

// ── rewriteModel — user rules ──

describe('rewriteModel — user rules', () => {
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
