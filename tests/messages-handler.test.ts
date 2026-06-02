import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { modelCache } from '~/state'
import { processAnthropicBetaHeader } from '~/transform/beta-headers'

import { buildModel, buildModelsResponse, clearConfig } from './helpers'

function setContextUpgradeRules(rules: Array<{ from: string, to: string }>) {
  const config = getCachedConfig() as Record<string, unknown>
  config.contextUpgradeRules = rules
}

// ── Setup / Teardown ──

let originalModels: ReturnType<typeof modelCache.getModels>

beforeEach(() => {
  originalModels = modelCache.getModels()
  modelCache.cacheModels(buildModelsResponse(
    buildModel('claude-opus-4.6'),
    buildModel('claude-opus-4.6-1m'),
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

// ── processAnthropicBetaHeader ──

describe('processAnthropicBetaHeader', () => {
  test('strips context-* beta when model is already a 1M variant', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-opus-4.6-1m')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })

  test('strips context-* beta when model has no upgrade rule at all', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-sonnet-4.5')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })

  test('strips context-* beta and upgrades when model has upgrade target', () => {
    setContextUpgradeRules([{ from: 'claude-opus-4.6', to: 'claude-opus-4.6-1m' }])
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-opus-4.6')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBe('claude-opus-4.6-1m')
  })

  test('preserves non-context betas in header', () => {
    setContextUpgradeRules([{ from: 'claude-opus-4.6', to: 'claude-opus-4.6-1m' }])
    const result = processAnthropicBetaHeader(
      'context-1m-2025-01-01,max-tokens-3-5-sonnet-2024-07-15',
      'claude-opus-4.6',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
    expect(result.upgradeTarget).toBe('claude-opus-4.6-1m')
  })
  test('strips mid-conversation system beta before forwarding to Copilot', () => {
    const result = processAnthropicBetaHeader(
      'mid-conversation-system-2026-04-07,max-tokens-3-5-sonnet-2024-07-15',
      'claude-opus-4.7',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
    expect(result.upgradeTarget).toBeUndefined()
  })

  test('returns undefined header when no betas provided', () => {
    const result = processAnthropicBetaHeader(null, 'claude-opus-4.6')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })
})
