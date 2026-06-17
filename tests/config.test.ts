import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  getCachedConfig,
  readConfig,
  writeConfigField,
} from '../src/lib/config'
import { configStore } from '../src/state/config-store'

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
      upstreamQueueMaxRetries: 4,
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
  afterAll(async () => {
    const config = getCachedConfig() as Record<string, unknown>
    for (const key of Object.keys(config)) {
      delete config[key]
    }
  })

  function clearCachedConfig() {
    const config = getCachedConfig() as Record<string, unknown>
    for (const key of Object.keys(config)) {
      delete config[key]
    }
  }

  // ── isCompactSmallModelEnabled ──

  test('isCompactSmallModelEnabled defaults to false', () => {
    clearCachedConfig()
    expect(configStore.isCompactSmallModelEnabled()).toBe(false)
  })

  test('isCompactSmallModelEnabled respects explicit true', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.compactUseSmallModel = true
    expect(configStore.isCompactSmallModelEnabled()).toBe(true)
  })

  // ── getSmallModel ──

  test('getSmallModel returns undefined by default', () => {
    clearCachedConfig()
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  test('getSmallModel returns trimmed string when set', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = '  gpt-4.1-mini  '
    expect(configStore.getSmallModel()).toBe('gpt-4.1-mini')
  })

  test('getSmallModel returns undefined for whitespace-only string', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = '   '
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  test('getSmallModel returns undefined for empty string', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.smallModel = ''
    expect(configStore.getSmallModel()).toBeUndefined()
  })

  // ── isFunctionApplyPatchEnabled ──

  test('isFunctionApplyPatchEnabled defaults to true', () => {
    clearCachedConfig()
    expect(configStore.isFunctionApplyPatchEnabled()).toBe(true)
  })

  test('isFunctionApplyPatchEnabled respects explicit false', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.useFunctionApplyPatch = false
    expect(configStore.isFunctionApplyPatchEnabled()).toBe(false)
  })

  // ── getReasoningEffort ──

  test('getReasoningEffort defaults to high', () => {
    clearCachedConfig()
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('high')
  })

  test('getReasoningEffort respects per-model config', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.modelReasoningEfforts = { 'claude-sonnet-4.5': 'low', 'gpt-5': 'medium' }
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('low')
    expect(configStore.getReasoningEffort('gpt-5')).toBe('medium')
  })

  test('getReasoningEffort falls back to high for unconfigured model', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.modelReasoningEfforts = { 'gpt-5': 'low' }
    expect(configStore.getReasoningEffort('claude-sonnet-4.5')).toBe('high')
  })

  // ── getModelRewrites ──

  test('getModelRewrites returns empty array by default', () => {
    clearCachedConfig()
    expect(configStore.getModelRewrites()).toEqual([])
  })

  test('getModelRewrites returns configured array', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    const rewrites = [{ from: 'claude-opus', to: 'gpt-5' }]
    config.modelRewrites = rewrites
    expect(configStore.getModelRewrites()).toEqual(rewrites)
  })

  // ── getModelFallback ──

  test('getModelFallback returns undefined by default', () => {
    clearCachedConfig()
    expect(configStore.getModelFallback()).toBeUndefined()
  })

  test('getModelFallback returns configured fallback', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.modelFallback = { claudeOpus: 'gpt-5' }
    expect(configStore.getModelFallback()).toEqual({ claudeOpus: 'gpt-5' })
  })

  // ── isContextManagementEnabled ──

  test('isContextManagementEnabled defaults to false', () => {
    clearCachedConfig()
    expect(configStore.isContextManagementEnabled()).toBe(false)
  })

  test('isContextManagementEnabled respects explicit true', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    expect(configStore.isContextManagementEnabled()).toBe(true)
  })

  // ── isContextManagementModel ──

  test('isContextManagementModel returns false when context management is disabled', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = false
    config.responsesApiContextManagementModels = ['gpt-5']
    expect(configStore.isContextManagementModel('gpt-5')).toBe(false)
  })

  test('isContextManagementModel returns true for listed model when enabled', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5', 'gpt-4.1']
    expect(configStore.isContextManagementModel('gpt-5')).toBe(true)
    expect(configStore.isContextManagementModel('gpt-4.1')).toBe(true)
  })

  test('isContextManagementModel returns false for unlisted model when enabled', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5']
    expect(configStore.isContextManagementModel('claude-sonnet-4.5')).toBe(false)
  })

  test('isContextManagementModel returns false when models list is absent', () => {
    clearCachedConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    expect(configStore.isContextManagementModel('gpt-5')).toBe(false)
  })
})
