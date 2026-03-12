import type { Model, ModelsResponse } from '~/types'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { Elysia } from 'elysia'

import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { handleCountTokensCore } from '~/routes/messages/count-tokens-handler'

function buildModel(id: string): Model {
  return {
    id,
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'openai',
    version: '1',
    capabilities: {
      family: 'gpt',
      limits: {
        max_context_window_tokens: 128000,
        max_output_tokens: 4096,
        max_prompt_tokens: 124000,
      },
      object: 'model_capabilities',
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
  }
}

function buildModelsResponse(...models: Array<Model>): ModelsResponse {
  return {
    object: 'list',
    data: models,
  }
}

function createApp() {
  return new Elysia()
    .error({ HTTP: HTTPError })
    .onError(({ code, error }) => {
      if (code === 'HTTP')
        return
      if (error instanceof Error && error.name === 'AbortError') {
        return Response.json(
          { error: { message: 'Upstream request was aborted', type: 'timeout_error' } },
          { status: 504 },
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      return Response.json(
        { error: { message, type: 'error' } },
        { status: 500 },
      )
    })
    .post('/v1/messages/count_tokens', async ({ body, request }) => {
      return handleCountTokensCore({
        body,
        headers: request.headers,
      })
    })
}

const originalModels = state.cache.models

beforeEach(() => {
  state.cache.models = undefined
})

afterEach(() => {
  state.cache.models = originalModels
})

describe('POST /v1/messages/count_tokens', () => {
  test('accepts payload without max_tokens and returns token count', async () => {
    state.cache.models = buildModelsResponse(buildModel('claude-haiku-4.5'))
    const app = createApp()

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
    state.cache.models = buildModelsResponse(buildModel('claude-haiku-4.5'))
    const app = createApp()

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
    state.cache.models = buildModelsResponse(buildModel('gpt-4.1'))
    const app = createApp()

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
