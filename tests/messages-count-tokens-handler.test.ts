import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { state } from '~/lib/state'

import { buildGptModel, buildModelsResponse, createApp } from './helpers'

const originalModels = state.cache.models

beforeEach(() => {
  state.cache.models = undefined
})

afterEach(() => {
  state.cache.models = originalModels
})

describe('POST /v1/messages/count_tokens', () => {
  test('accepts payload without max_tokens and returns token count', async () => {
    state.cache.models = buildModelsResponse(buildGptModel('claude-haiku-4.5'))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(200)
    const json = (await response.json()) as { input_tokens: number }
    expect(typeof json.input_tokens).toBe('number')
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test('returns 400 on invalid payload instead of fake success', async () => {
    state.cache.models = buildModelsResponse(buildGptModel('claude-haiku-4.5'))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('Invalid request payload')
  })

  test('returns 400 when model cannot be resolved', async () => {
    state.cache.models = buildModelsResponse(buildGptModel('gpt-4.1'))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('Model not found for token counting')
  })
})
