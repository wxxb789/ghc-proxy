import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { CapturedMessagesCall, CapturedResponsesCall } from './helpers'

import { Buffer } from 'node:buffer'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { createServer } from '~/server'
import { authStore, modelCache, runtimeStore } from '~/state'

import {
  buildGptModel,
  buildModelsResponse,
  buildResponsesResult,
  clearConfig,
  mockMessages,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

let snapshot: ReturnType<typeof saveStateSnapshot>
let createChatCompletions: typeof CopilotClient.prototype.createChatCompletions
let createEmbeddings: typeof CopilotClient.prototype.createEmbeddings
let createMessages: typeof CopilotClient.prototype.createMessages
let createResponses: typeof CopilotClient.prototype.createResponses
let getResponse: typeof CopilotClient.prototype.getResponse

beforeEach(() => {
  snapshot = saveStateSnapshot()
  createChatCompletions = CopilotClient.prototype.createChatCompletions
  createEmbeddings = CopilotClient.prototype.createEmbeddings
  createMessages = CopilotClient.prototype.createMessages
  createResponses = CopilotClient.prototype.createResponses
  getResponse = CopilotClient.prototype.getResponse
  clearConfig()
  setupDefaultTestState()
  runtimeStore.requests.reset()
})

afterEach(() => {
  CopilotClient.prototype.createChatCompletions = createChatCompletions
  CopilotClient.prototype.createEmbeddings = createEmbeddings
  CopilotClient.prototype.createMessages = createMessages
  CopilotClient.prototype.createResponses = createResponses
  CopilotClient.prototype.getResponse = getResponse
  runtimeStore.requests.reset()
  clearConfig()
  restoreStateSnapshot(snapshot)
})

async function settleResponse(response: Response): Promise<void> {
  await response.text()
  await new Promise(resolve => setTimeout(resolve, 50))
}

function createTerminalLessResponsesStream(
  model = 'gpt-5.6-sol',
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  return (async function* () {
    yield {
      event: 'response.created',
      data: JSON.stringify({
        type: 'response.created',
        sequence_number: 0,
        response: buildResponsesResult({ model, status: 'in_progress' }),
      }),
    }
  })()
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

  test('counts only function schemas that actually change', async () => {
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
    })))
    CopilotClient.prototype.createResponses = mockResponses(
      buildResponsesResult({ model: 'gpt-5.6-sol', status: 'completed' }),
      calls,
    )

    const response = await createServer().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'unchanged',
            parameters: { type: 'object', properties: { value: { type: 'string' } } },
          },
          {
            type: 'function',
            name: 'changed',
            parameters: { type: 'object', title: 'metadata', properties: {} },
          },
          {
            type: 'function',
            name: 'strict-null',
            parameters: { type: 'object', properties: {} },
            strict: null,
          },
        ],
      }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.tools?.[1]).toMatchObject({
      parameters: { type: 'object', properties: {} },
    })
    expect(calls[0]?.payload.tools?.[2]).not.toHaveProperty('strict')
    expect(runtimeStore.requests.snapshot().recent[0]?.effects).toContainEqual({
      id: 'responses.function_schema_normalized',
      count: 2,
    })
  })

  test('counts only cache_control blocks that actually change', async () => {
    const calls: Array<CapturedMessagesCall> = []
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-sonnet-4.5', {
      supported_endpoints: ['/v1/messages'],
    })))
    CopilotClient.prototype.createMessages = mockMessages({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-sonnet-4.5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, calls)

    const response = await createServer().handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 64,
        system: [
          { type: 'text', text: 'unchanged', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'changed', cache_control: { type: 'ephemeral', scope: 'turn' } },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(runtimeStore.requests.snapshot().recent[0]?.effects).toContainEqual({
      id: 'messages.cache_control_sanitized',
      count: 1,
    })
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

  test('marks a clean Responses EOF without a terminal event as failed metadata', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
    })))
    CopilotClient.prototype.createResponses = mockResponses(
      createTerminalLessResponsesStream(),
      [],
    )

    const response = await createServer().handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello', stream: true }),
    }))
    const body = await response.text()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(200)
    expect(body).toContain('event: response.created')
    expect(body).not.toContain('response.completed')
    expect(body).not.toContain('response.incomplete')
    expect(body).not.toContain('response.failed')
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: '/v1/responses',
      state: 'failed',
      status: 200,
      errorSummary: 'Upstream HTTP 200 (response_stream_eof)',
    })
  })

  test('marks a clean Messages-via-Responses EOF without a terminal event as failed metadata', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/responses'],
    })))
    CopilotClient.prototype.createResponses = mockResponses(
      createTerminalLessResponsesStream(),
      [],
    )

    const response = await createServer().handle(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    }))
    const body = await response.text()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(200)
    expect(body).toContain('Responses stream ended without completion')
    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: '/v1/messages',
      selectedStrategy: 'responses-api',
      state: 'failed',
      status: 200,
      errorSummary: 'Upstream HTTP 200 (response_stream_eof)',
    })
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

  test('records a client-aborted streaming delivery as aborted', async () => {
    authStore.upstreamTimeoutSeconds = 0
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/chat/completions'],
    })))
    let markCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    CopilotClient.prototype.createChatCompletions = ((_payload, options) => {
      const signal = options?.signal
      return Promise.resolve((async function* () {
        yield {
          data: JSON.stringify({
            id: 'stream_abort',
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
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        markCancelled?.()
        throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      })())
    }) as typeof CopilotClient.prototype.createChatCompletions

    const app = createServer().listen({ hostname: '127.0.0.1', port: 0 })
    try {
      const port = app.server?.port
      expect(port).toBeNumber()
      const body = JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      })
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: port! }, () => {
          socket.write([
            'POST /v1/chat/completions HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'))
        })
        let received = ''
        socket.on('data', (chunk) => {
          received += chunk.toString()
          if (!received.includes('hello'))
            return
          socket.destroy()
          resolve()
        })
        socket.once('error', reject)
      })
      await cancelled
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(runtimeStore.requests.snapshot()).toMatchObject({
        active: [],
        recent: [{
          endpoint: '/v1/chat/completions',
          state: 'aborted',
          status: 200,
        }],
        totals: {
          started: 1,
          completed: 0,
          failed: 0,
          aborted: 1,
        },
      })
    }
    finally {
      await app.stop(true)
    }
  })

  test('records a client abort before upstream headers as aborted', async () => {
    authStore.upstreamTimeoutSeconds = 0
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.6-sol', {
      supported_endpoints: ['/chat/completions'],
    })))
    let markStarted: (() => void) | undefined
    let markCancelled: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    CopilotClient.prototype.createChatCompletions = (async (_payload, options) => {
      const signal = options?.signal
      if (!signal)
        throw new Error('no signal reached the client')
      markStarted?.()
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      markCancelled?.()
      throw signal.reason
    }) as typeof CopilotClient.prototype.createChatCompletions

    const controller = new AbortController()
    const responsePromise = createServer().handle(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      signal: controller.signal,
    }))
    await started
    controller.abort()

    const response = await responsePromise
    await cancelled
    await settleResponse(response)

    expect(response.status).toBe(504)
    expect(runtimeStore.requests.snapshot()).toMatchObject({
      active: [],
      recent: [{
        endpoint: '/v1/chat/completions',
        state: 'aborted',
        status: 504,
      }],
      totals: {
        started: 1,
        completed: 0,
        failed: 0,
        aborted: 1,
      },
    })
  })

  test('records an embeddings client abort outside the pipeline', async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    CopilotClient.prototype.createEmbeddings = (async (_payload, options) => {
      const signal = options?.signal
      if (!signal)
        throw new Error('no signal reached the client')
      markStarted?.()
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      throw signal.reason
    }) as typeof CopilotClient.prototype.createEmbeddings

    const controller = new AbortController()
    const responsePromise = createServer().handle(new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
      signal: controller.signal,
    }))
    await started
    controller.abort()

    const response = await responsePromise
    await settleResponse(response)

    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: '/v1/embeddings',
      state: 'aborted',
      status: 504,
    })
  })

  test('records a Responses resource client abort outside the pipeline', async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    CopilotClient.prototype.getResponse = (async (_responseId, options) => {
      const signal = options?.signal
      if (!signal)
        throw new Error('no signal reached the client')
      markStarted?.()
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      throw signal.reason
    }) as typeof CopilotClient.prototype.getResponse

    const controller = new AbortController()
    const responsePromise = createServer().handle(new Request(
      'http://localhost/v1/responses/resp_abort',
      { signal: controller.signal },
    ))
    await started
    controller.abort()

    const response = await responsePromise
    await settleResponse(response)

    expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
      endpoint: '/v1/responses/:responseId',
      state: 'aborted',
      status: 504,
    })
  })
})
