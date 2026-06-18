import { beforeEach, describe, expect, test } from 'bun:test'

import { authStore, modelCache } from '~/state'

import { buildModel, buildModelsResponse } from './helpers'

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
    const { createCopilotClient } = await import('~/clients/factory')
    authStore.copilotToken = 'test-token'
    authStore.copilotApiBase = 'https://test-api.com'
    const client = createCopilotClient()
    expect(client).toBeDefined()
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
