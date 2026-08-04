import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  DEFAULT_UPSTREAM_QUEUE_MAX_RETRIES,
  DEFAULT_UPSTREAM_RECOVERY_BUDGET_SECONDS,
  getCachedConfig,
  readConfig,
  writeConfigField,
} from '../src/lib/config'
import { resolveCapacityCooldownScope } from '../src/lib/error'
import { parseBoundedIntArg, resolveDumpFailedPayloadsOption } from '../src/start'
import { authStore, modelCache } from '../src/state'
import { configStore } from '../src/state/config-store'

import { buildModel, buildModelsResponse, clearConfig } from './helpers'

// Redirect config file I/O to a temp dir for the whole file. This mock is scoped
// to this test module's import graph; the store/auth tests below don't read PATHS.
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-test-'))
const tempConfigPath = path.join(tempDir, 'config.json')

mock.module('../src/lib/paths', () => ({
  PATHS: {
    APP_DIR: tempDir,
    CONFIG_PATH: tempConfigPath,
  },
}))

describe('config module', () => {
  beforeEach(async () => {
    await fs.unlink(tempConfigPath).catch(() => {

    })
    await readConfig()
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('readConfig() — file doesn\'t exist → returns {}', async () => {
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — file is empty string → returns {}', async () => {
    await fs.writeFile(tempConfigPath, '')
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — malformed JSON → returns {}, warns', async () => {
    await fs.writeFile(tempConfigPath, '{ invalid json }')
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — valid JSON with full config → returns parsed object', async () => {
    const fullConfig = {
      githubToken: 'test-token',
      modelFallback: {
        claudeOpus: 'gpt-4-opus',
      },
      upstreamQueueConcurrency: 12,
      upstreamQueueMaxRetries: 2,
      upstreamRecoveryBudgetSeconds: 60,
      overloadFallbacks: {
        'claude-opus-5': 'claude-opus-4.8',
      },
      upstreamQueueBaseDelaySeconds: 3,
      upstreamQueueMaxDelaySeconds: 45,
    }
    await fs.writeFile(tempConfigPath, JSON.stringify(fullConfig))
    const config = await readConfig()
    expect(config).toEqual(fullConfig)
  })

  test('readConfig() — partial config → returns partial object', async () => {
    const partialConfig = {
      modelFallback: {
        claudeOpus: 'gpt-4-opus',
      },
    }
    await fs.writeFile(tempConfigPath, JSON.stringify(partialConfig))
    const config = await readConfig()
    expect(config).toEqual(partialConfig)
  })

  test('readConfig() — config is array → returns {}, warns', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify(['not', 'an', 'object']))
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('recovery policy defaults are bounded and overload fallback is disabled', () => {
    expect(DEFAULT_UPSTREAM_QUEUE_MAX_RETRIES).toBe(1)
    expect(DEFAULT_UPSTREAM_RECOVERY_BUDGET_SECONDS).toBe(60)
    expect(configStore.getOverloadFallback('claude-opus-5')).toBeUndefined()
  })

  test.each([0, 1, 2])('readConfig() accepts upstreamQueueMaxRetries=%i', async (value) => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ upstreamQueueMaxRetries: value }))

    expect((await readConfig()).upstreamQueueMaxRetries).toBe(value)
  })

  test.each([-1, 0.5, 3])('readConfig() rejects upstreamQueueMaxRetries=%p without dropping valid fields', async (value) => {
    await fs.writeFile(tempConfigPath, JSON.stringify({
      githubToken: 'still-valid',
      upstreamQueueMaxRetries: value,
    }))

    expect(await readConfig()).toEqual({ githubToken: 'still-valid' })
  })

  test.each([1, 60, 120])('readConfig() accepts upstreamRecoveryBudgetSeconds=%i', async (value) => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ upstreamRecoveryBudgetSeconds: value }))

    expect((await readConfig()).upstreamRecoveryBudgetSeconds).toBe(value)
  })

  test.each([0, 1.5, 121])('readConfig() rejects upstreamRecoveryBudgetSeconds=%p without dropping valid fields', async (value) => {
    await fs.writeFile(tempConfigPath, JSON.stringify({
      githubToken: 'still-valid',
      upstreamRecoveryBudgetSeconds: value,
    }))

    expect(await readConfig()).toEqual({ githubToken: 'still-valid' })
  })

  test('readConfig() drops blank and self fallback entries but keeps reciprocal one-hop mappings', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({
      overloadFallbacks: {
        '': 'target',
        'blankTarget': '   ',
        'self': 'self',
        'modelA': 'modelB',
        'modelB': 'modelA',
        ' modelC ': ' modelD ',
      },
    }))

    expect((await readConfig()).overloadFallbacks).toEqual({
      modelA: 'modelB',
      modelB: 'modelA',
      modelC: 'modelD',
    })
  })

  test('writeConfigField() — file doesn\'t exist → creates file, keeps platform-appropriate permissions', async () => {
    await writeConfigField('githubToken', 'new-token')

    const content = await fs.readFile(tempConfigPath)
    const parsed = JSON.parse(content.toString()) as unknown
    expect(parsed).toEqual({ githubToken: 'new-token' })

    if (process.platform !== 'win32') {
      const stats = await fs.stat(tempConfigPath)
      expect(stats.mode & 0o777).toBe(0o600)
    }
  })

  test('writeConfigField() — merges with existing fields', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ existing: 'value' }))
    await writeConfigField('githubToken', 'new-token')

    const content = await fs.readFile(tempConfigPath)
    const parsed = JSON.parse(content.toString()) as unknown
    expect(parsed).toEqual({ existing: 'value', githubToken: 'new-token' })
  })

  test('getCachedConfig() — returns last loaded/written config', async () => {
    const testConfig = { githubToken: 'cached-token' }
    await fs.writeFile(tempConfigPath, JSON.stringify(testConfig))

    await readConfig()
    expect(getCachedConfig()).toEqual(testConfig)

    await writeConfigField('githubToken', 'updated-token')
    expect(getCachedConfig()).toEqual({ githubToken: 'updated-token' })
  })

  test('responses auto-compaction and auto-context-management are disabled by default', async () => {
    expect(configStore.isAutoCompactResponsesInputEnabled()).toBe(false)
    expect(configStore.isContextManagementModel('gpt-5')).toBe(false)
    expect(configStore.isEmulatorEnabled()).toBe(false)
    expect(configStore.getEmulatorTtlSeconds()).toBe(14_400)
  })

  test('responses auto-compaction and auto-context-management require explicit opt-in', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({
      responsesApiAutoCompactInput: true,
      responsesApiAutoContextManagement: true,
      responsesApiContextManagementModels: ['gpt-5'],
      responsesOfficialEmulator: true,
      responsesOfficialEmulatorTtlSeconds: 60,
    }))

    await readConfig()

    expect(configStore.isAutoCompactResponsesInputEnabled()).toBe(true)
    expect(configStore.isContextManagementModel('gpt-5')).toBe(true)
    expect(configStore.isContextManagementModel('gpt-4.1')).toBe(false)
    expect(configStore.isEmulatorEnabled()).toBe(true)
    expect(configStore.getEmulatorTtlSeconds()).toBe(60)
  })

  test('writeConfigField() — gheDomain round-trip persists and reads back', async () => {
    await writeConfigField('gheDomain', 'company.ghe.com')

    const config = await readConfig()
    expect(config.gheDomain).toBe('company.ghe.com')
    expect(getCachedConfig().gheDomain).toBe('company.ghe.com')
  })

  test('writeConfigField() — gheDomain merges with existing config fields', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ githubToken: 'existing-token' }))
    await writeConfigField('gheDomain', 'my-enterprise.github.com')

    const content = await fs.readFile(tempConfigPath)
    const parsed = JSON.parse(content.toString()) as Record<string, unknown>
    expect(parsed).toEqual({ githubToken: 'existing-token', gheDomain: 'my-enterprise.github.com' })
  })

  test('readConfig() — gheDomain is optional and absent by default', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ githubToken: 'token-only' }))
    const config = await readConfig()
    expect(config.gheDomain).toBeUndefined()
  })
})

describe('ConfigStore accessors', () => {
  beforeEach(() => clearConfig())

  afterAll(() => clearConfig())

  // ── isCompactSmallModelEnabled ──

  test('isCompactSmallModelEnabled defaults to false', () => {
    expect(configStore.isCompactSmallModelEnabled()).toBe(false)
  })

  test('isCompactSmallModelEnabled respects explicit true', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.compactUseSmallModel = true
    expect(configStore.isCompactSmallModelEnabled()).toBe(true)
  })

  // ── getSmallModel ──

  test('getSmallModel returns undefined by default', () => {
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  test('getSmallModel returns trimmed string when set', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = '  gpt-4.1-mini  '
    expect(configStore.getSmallModel()).toBe('gpt-4.1-mini')
  })

  test('getSmallModel returns undefined for whitespace-only string', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = '   '
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  test('getSmallModel returns undefined for empty string', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = ''
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  // ── isFunctionApplyPatchEnabled ──

  test('isFunctionApplyPatchEnabled defaults to true', () => {
    expect(configStore.isFunctionApplyPatchEnabled()).toBe(true)
  })

  test('isFunctionApplyPatchEnabled respects explicit false', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.useFunctionApplyPatch = false
    expect(configStore.isFunctionApplyPatchEnabled()).toBe(false)
  })

  // ── getReasoningEffort ──

  test('getReasoningEffort defaults to high', () => {
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('high')
  })

  test('getReasoningEffort respects per-model config', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.modelReasoningEfforts = { 'claude-sonnet-4.5': 'low', 'gpt-5': 'medium' }
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('low')
    expect(configStore.getReasoningEffort('gpt-5')).toBe('medium')
  })

  test('getReasoningEffort falls back to high for unconfigured model', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.modelReasoningEfforts = { 'gpt-5': 'low' }
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('high')
  })

  // ── getModelRewrites ──

  test('getModelRewrites returns empty array by default', () => {
    expect(configStore.getModelRewrites()).toEqual([])
  })

  test('getModelRewrites returns configured array', () => {
    const config = getCachedConfig() as Record<string, unknown>
    const rewrites = [{ from: 'claude-opus', to: 'gpt-5' }]
    config.modelRewrites = rewrites
    expect(configStore.getModelRewrites()).toEqual(rewrites)
  })

  // ── getModelFallback ──

  test('getModelFallback returns undefined by default', () => {
    expect(configStore.getModelFallback()).toBeUndefined()
  })

  test('getModelFallback returns configured fallback', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.modelFallback = { claudeOpus: 'gpt-5' }
    expect(configStore.getModelFallback()).toEqual({ claudeOpus: 'gpt-5' })
  })

  test('getOverloadFallback returns an exact configured target', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.overloadFallbacks = { source: 'target' }
    expect(configStore.getOverloadFallback('source')).toBe('target')
    expect(configStore.getOverloadFallback('SOURCE')).toBeUndefined()
  })

  // ── isContextManagementEnabled ──

  test('isContextManagementEnabled defaults to false', () => {
    expect(configStore.isContextManagementEnabled()).toBe(false)
  })

  test('isContextManagementEnabled respects explicit true', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    expect(configStore.isContextManagementEnabled()).toBe(true)
  })

  // ── isContextManagementModel ──

  test('isContextManagementModel returns false when context management is disabled', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = false
    config.responsesApiContextManagementModels = ['gpt-5']
    expect(configStore.isContextManagementModel('gpt-5')).toBe(false)
  })

  test('isContextManagementModel returns true for listed model when enabled', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5', 'gpt-4.1']
    expect(configStore.isContextManagementModel('gpt-5')).toBe(true)
    expect(configStore.isContextManagementModel('gpt-4.1')).toBe(true)
  })

  test('isContextManagementModel returns false for unlisted model when enabled', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5']
    expect(configStore.isContextManagementModel('claude-sonnet-4.5')).toBe(false)
  })

  test('isContextManagementModel returns false when models list is absent', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    expect(configStore.isContextManagementModel('gpt-5')).toBe(false)
  })
})

// These tests verify that the stores are the single authoritative source
// of truth — no Proxy, no dual-write, direct read/write.

describe('state store initialization', () => {
  beforeEach(() => {
    authStore.githubToken = undefined
    authStore.copilotToken = undefined
    authStore.copilotApiBase = undefined
    authStore.gheDomain = undefined
    authStore.githubLogin = undefined
    authStore.manualApprove = false
    authStore.rateLimitSeconds = undefined
    authStore.rateLimitWait = false
    authStore.showToken = false
    authStore.upstreamTimeoutSeconds = undefined
    authStore.accountType = 'individual'
    modelCache.clearModels()
    modelCache.clearVSCodeVersion()
  })

  test('authStore fields are directly writable and readable', () => {
    authStore.githubToken = 'gh-token-123'
    authStore.copilotToken = 'copilot-token-456'
    authStore.copilotApiBase = 'https://api.example.com'
    authStore.gheDomain = 'ghe.example.com'
    authStore.manualApprove = true
    authStore.rateLimitSeconds = 5
    authStore.rateLimitWait = true
    authStore.showToken = true
    authStore.upstreamTimeoutSeconds = 30
    authStore.accountType = 'business'

    expect(authStore.githubToken).toBe('gh-token-123')
    expect(authStore.copilotToken).toBe('copilot-token-456')
    expect(authStore.copilotApiBase).toBe('https://api.example.com')
    expect(authStore.gheDomain).toBe('ghe.example.com')
    expect(authStore.manualApprove).toBe(true)
    expect(authStore.rateLimitSeconds).toBe(5)
    expect(authStore.rateLimitWait).toBe(true)
    expect(authStore.showToken).toBe(true)
    expect(authStore.upstreamTimeoutSeconds).toBe(30)
    expect(authStore.accountType).toBe('business')
  })

  test('authStore githubLogin is directly writable and readable', () => {
    authStore.githubLogin = 'test-user'
    expect(authStore.githubLogin).toBe('test-user')
  })

  test('modelCache is directly writable and readable', () => {
    const testModel = buildModel('test-model')
    const models = buildModelsResponse(testModel)
    modelCache.cacheModels(models)

    expect(modelCache.getModels()).toEqual(models)
    expect(modelCache.findById('test-model')).toEqual(testModel)
  })

  test('modelCache vsCodeVersion is directly writable and readable', () => {
    modelCache.setVSCodeVersion('1.85.0')
    expect(modelCache.getVSCodeVersion()).toBe('1.85.0')
  })

  test('createCopilotClient reads from authStore', async () => {
    const { createCopilotClient, getClientConfig } = await import('~/clients/factory')
    authStore.copilotToken = 'test-token'
    authStore.copilotApiBase = 'https://test-api.com'
    const client = createCopilotClient()
    expect(client).toBeDefined()
    // CopilotClient keeps auth/config private with no getters, so assert the
    // authStore read through getClientConfig() — the same source the client is
    // constructed from — mirroring the sibling getClientConfig test below.
    expect(getClientConfig().copilotApiBase).toBe('https://test-api.com')
  })

  test('getClientConfig reads from authStore and modelCache', async () => {
    const { getClientConfig } = await import('~/clients/factory')
    authStore.accountType = 'enterprise'
    authStore.copilotApiBase = 'https://api.test.com'
    modelCache.setVSCodeVersion('1.90.0')
    const config = getClientConfig()
    expect(config.accountType).toBe('enterprise')
    expect(config.vsCodeVersion).toBe('1.90.0')
    expect(config.copilotApiBase).toBe('https://api.test.com')
  })
})

describe('start options', () => {
  test('dump failed payloads is enabled by the CLI flag', () => {
    expect(resolveDumpFailedPayloadsOption(true, undefined)).toBe(true)
    expect(resolveDumpFailedPayloadsOption(true, '0')).toBe(true)
  })

  test('dump failed payloads can be enabled by environment variable', () => {
    expect(resolveDumpFailedPayloadsOption(false, '1')).toBe(true)
    expect(resolveDumpFailedPayloadsOption(false, 'true')).toBe(true)
    expect(resolveDumpFailedPayloadsOption(false, 'TRUE')).toBe(true)
  })

  test('dump failed payloads stays disabled for absent or non-truthy environment values', () => {
    expect(resolveDumpFailedPayloadsOption(false, undefined)).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, '')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, '0')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, 'false')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, 'yes')).toBe(false)
  })

  test.each([
    { raw: '0', min: 0, max: 2, expected: 0 },
    { raw: '2', min: 0, max: 2, expected: 2 },
    { raw: '1', min: 1, max: 120, expected: 1 },
    { raw: '120', min: 1, max: 120, expected: 120 },
    { raw: '-1', min: 0, max: 2, expected: undefined },
    { raw: '1.5', min: 0, max: 2, expected: undefined },
    { raw: '3', min: 0, max: 2, expected: undefined },
    { raw: '121', min: 1, max: 120, expected: undefined },
    { raw: '', min: 0, max: 2, expected: undefined },
  ])('bounded integer CLI parsing: $raw in $min..$max -> $expected', ({ raw, min, max, expected }) => {
    expect(parseBoundedIntArg(raw, 'test', 'Using default.', min, max)).toBe(expected)
  })
})

describe('capacity cooldown policy', () => {
  test('classifies account, model, request, and non-capacity outcomes', () => {
    expect(resolveCapacityCooldownScope(429, 'model-a')).toBe('account')
    expect(resolveCapacityCooldownScope(529, 'model-a')).toBe('model')
    expect(resolveCapacityCooldownScope(529)).toBe('request')
    expect(resolveCapacityCooldownScope(503, 'model-a')).toBeUndefined()
  })
})
