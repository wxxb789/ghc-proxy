import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createServer } from '~/server'
import { authStore, modelCache } from '~/state'
import { VERSION } from '~/util/version'
import {
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalState = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
})

afterEach(() => {
  restoreStateSnapshot(originalState)
})

describe('health endpoint', () => {
  test('GET /health returns 200 with full status when token and models are present', async () => {
    const app = createServer()

    const response = await app.handle(new Request('http://localhost/health'))

    expect(response.status).toBe(200)
    const json = await response.json() as Record<string, unknown>
    expect(json.status).toBe('ok')
    expect(json.copilotToken).toBe(true)
    expect(json.modelsLoaded).toBe(true)
    expect(json.version).toBe(VERSION)
  })

  test('GET /health reports copilotToken false when token is cleared', async () => {
    authStore.copilotToken = undefined
    const app = createServer()

    const response = await app.handle(new Request('http://localhost/health'))

    expect(response.status).toBe(200)
    const json = await response.json() as Record<string, unknown>
    expect(json.status).toBe('ok')
    expect(json.copilotToken).toBe(false)
    expect(json.modelsLoaded).toBe(true)
  })

  test('GET /health reports modelsLoaded false when models are cleared', async () => {
    modelCache.clearModels()
    const app = createServer()

    const response = await app.handle(new Request('http://localhost/health'))

    expect(response.status).toBe(200)
    const json = await response.json() as Record<string, unknown>
    expect(json.status).toBe('ok')
    expect(json.copilotToken).toBe(true)
    expect(json.modelsLoaded).toBe(false)
  })

  test('GET /health reports both false when token and models are absent', async () => {
    authStore.copilotToken = undefined
    modelCache.clearModels()
    const app = createServer()

    const response = await app.handle(new Request('http://localhost/health'))

    expect(response.status).toBe(200)
    const json = await response.json() as Record<string, unknown>
    expect(json.copilotToken).toBe(false)
    expect(json.modelsLoaded).toBe(false)
  })

  test('GET / returns server running message', async () => {
    const app = createServer()

    const response = await app.handle(new Request('http://localhost/'))

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('Server running')
  })
})
