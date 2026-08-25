import type { CapturedResponsesCall } from './helpers'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { createServer } from '~/server'
import { modelCache, runtimeStore } from '~/state'

import {
  buildGptModel,
  buildModelsResponse,
  buildResponsesResult,
  clearConfig,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

let snapshot: ReturnType<typeof saveStateSnapshot>
let createChatCompletions: typeof CopilotClient.prototype.createChatCompletions
let createResponses: typeof CopilotClient.prototype.createResponses

beforeEach(() => {
  snapshot = saveStateSnapshot()
  createChatCompletions = CopilotClient.prototype.createChatCompletions
  createResponses = CopilotClient.prototype.createResponses
  clearConfig()
  setupDefaultTestState()
  runtimeStore.requests.reset()
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = createChatCompletions
  CopilotClient.prototype.createResponses = createResponses
  runtimeStore.requests.reset()
  clearConfig()
  restoreStateSnapshot(snapshot)
})

async function settleResponse(response: Response): Promise<void> {
  await response.text()
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('dashboard request lifecycle', () => {
  test('records a successful request without changing its response', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/health?token=must-not-be-stored'),
    )
    const clone = response.clone()
    await settleResponse(response)

    expect(clone.status).toBe(200)
    expect(await clone.json()).toMatchObject({ status: 'ok' })
    expect(runtimeStore.requests.snapshot()).toMatchObject({
      active: [],
      recent: [{
        method: 'GET',
        endpoint: '/health',
        state: 'completed',
        status: 200,
      }],
    })
    expect(JSON.stringify(runtimeStore.requests.snapshot())).not.toContain('must-not-be-stored')
  })

  test('records unmatched routes as sanitized failures', async () => {
    const response = await createServer().handle(
      new Request('http://localhost/private/secret-resource?authorization=secret'),
    )
    await settleResponse(response)

    expect(response.status).toBe(404)
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: 'unmatched',
      state: 'failed',
      status: 404,
      errorSummary: 'Unknown endpoint',
    })
    expect(JSON.stringify(runtimeStore.requests.snapshot())).not.toContain('secret-resource')
  })

  test('records source-emitted model, strategy, and transform effects', async () => {
    const calls: Array<CapturedResponsesCall> = []
    const model = buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
      capabilities: {
        ...buildGptModel('gpt-5.6-sol').capabilities,
        supports: {
          tool_calls: true,
          reasoning_effort: ['low'],
        },
      },
    })
    modelCache.cacheModels(buildModelsResponse(model))
    Object.assign(getCachedConfig(), {
      responsesApiAutoContextManagement: true,
      responsesApiContextManagementModels: ['gpt-5.6-sol'],
    })
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({ model: 'gpt-5.6-sol', status: 'completed' }),
      calls,
    )

    const response = await createServer().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [{
          type: 'message',
          role: 'user',
          content: 'hello',
          phase: 'commentary',
        }],
        store: true,
        temperature: 0.5,
        top_p: 0.5,
        max_output_tokens: 1,
        reasoning: { effort: 'high' },
      }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const request = runtimeStore.requests.snapshot().recent[0]
    expect(request).toMatchObject({
      requestedModel: 'gpt-5.6-sol',
      effectiveModel: 'gpt-5.6-sol',
      selectedStrategy: 'responses-passthrough',
      state: 'completed',
    })
    expect(request?.effects.map(effect => effect.id)).toEqual(expect.arrayContaining([
      'strategy.responses_passthrough',
      'responses.store_disabled',
      'responses.phase_filtered',
      'responses.context_management',
      'responses.parameter_filter',
      'responses.output_tokens_raised',
      'responses.reasoning_effort_lowered',
    ]))
  })

  test('marks an HTTP 200 Responses terminal failure as failed metadata', async () => {
    const model = buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(model))
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({
        model: 'gpt-5.6-sol',
        status: 'failed',
        error: { message: 'raw upstream detail' },
      }),
      [],
    )

    const response = await createServer().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      state: 'failed',
      status: 200,
      errorSummary: 'Upstream HTTP 200 (response_failed)',
    })
    expect(JSON.stringify(runtimeStore.requests.snapshot())).not.toContain('raw upstream detail')
  })

  test('marks a Messages-via-Responses terminal failure as failed metadata', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
    })))
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({
        model: 'gpt-5.6-sol',
        status: 'failed',
        error: { message: 'raw translated upstream detail' },
      }),
      [],
    )

    const response = await createServer().handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: '/v1/messages',
      selectedStrategy: 'responses-api',
      state: 'failed',
      status: 200,
      errorSummary: 'Upstream HTTP 200 (response_failed)',
    })
    expect(
      JSON.stringify(runtimeStore.requests.snapshot()),
    ).not.toContain('raw translated upstream detail')
  })

  test('retains sanitized failure metadata after a streaming response starts', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/chat/completions'],
    })))
    let releaseStream: (() => void) | undefined
    let markStreamStarted: (() => void) | undefined
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve
    })
    CopilotClient.prototype.createChatCompletions = (() => Promise.resolve((async function* () {
      markStreamStarted?.()
      yield {
        data: JSON.stringify({
          id: 'stream_1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-5.6-sol',
          choices: [{
            index: 0,
            delta: { content: 'hello' },
            finish_reason: null,
            logprobs: null,
          }],
        }),
      }
      await streamGate
      throw new Error('raw upstream stream secret')
    })())) as typeof CopilotClient.prototype.createChatCompletions

    const app = createServer().listen({ hostname: '127.0.0.1', port: 0 })
    try {
      const port = app.server?.port
      expect(port).toBeNumber()
      const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      })

      await streamStarted
      expect(runtimeStore.requests.snapshot().active[0]).toMatchObject({
        endpoint: '/v1/chat/completions',
        state: 'streaming',
      })

      releaseStream?.()
      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('hello')
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
        endpoint: '/v1/chat/completions',
        state: 'failed',
        status: 200,
        errorSummary: 'Unhandled proxy error',
      })
      expect(
        JSON.stringify(runtimeStore.requests.snapshot()),
      ).not.toContain('raw upstream stream secret')
    }
    finally {
      releaseStream?.()
      await app.stop(true)
    }
  })
})
