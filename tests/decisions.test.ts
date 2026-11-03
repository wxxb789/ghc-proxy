import type { CopilotClient } from '~/clients'
import type { Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

import { CopilotClient as Client } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { isClientAbortError } from '~/lib/upstream-signal'
import { handleDecisionsCore } from '~/routes/decisions/handler'
import { createDecisionRoutes } from '~/routes/decisions/route'
import { createServer, toErrorResponse } from '~/server'
import { modelCache, runtimeStore } from '~/state'
import {
  buildModel,
  buildModelsResponse,
  clearConfig,
  setupDefaultTestState,
} from './helpers'

type SystemOnePayload = Parameters<CopilotClient['createSystemOne']>[0]
type SystemOneOptions = Parameters<CopilotClient['createSystemOne']>[1]
type GetModelsOptions = Parameters<CopilotClient['getModels']>[0]

const originalCreateSystemOne = Client.prototype.createSystemOne
const originalGetModels = Client.prototype.getModels

const validBody = {
  model: 'microsoft-decision-1',
  input: 'Ship the release?',
  questions: [
    {
      type: 'choice',
      instructions: 'Pick one.',
      choices: [
        { value: true, description: 'Yes' },
        { value: false, description: 'No' },
      ],
    },
  ],
}

const validResponse = {
  model: 'microsoft-decision-1',
  answers: {
    q0: {
      type: 'choice',
      choice: 'c0',
      confidence: 0.9,
      probabilities: { c0: 0.9, c1: 0.1 },
    },
  },
  usage: {
    input_tokens: 2,
    output_tokens: 1,
  },
}

function createDecisionsApp() {
  return new Elysia()
    .error({ HTTP: HTTPError })
    .onError(({ code, error }) => toErrorResponse({ code, error }))
    .use(createDecisionRoutes())
    .group('/v1', app => app.use(createDecisionRoutes()))
}

function post(path: string, body: unknown, signal?: AbortSignal) {
  return createDecisionsApp().handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  }))
}

function decisionModel(overrides: Partial<Model> = {}) {
  return buildModel('microsoft-decision-1', {
    vendor: 'microsoft',
    supported_endpoints: ['/v1/systemone'],
    ...overrides,
  })
}

describe('decisions route', () => {
  let createCalls: Array<{ payload: SystemOnePayload, options?: SystemOneOptions }>
  let getModelsCalls: number
  let createImpl: (payload: SystemOnePayload) => Promise<unknown>

  beforeEach(() => {
    setupDefaultTestState()
    modelCache.cacheModels(buildModelsResponse(decisionModel()))
    createCalls = []
    getModelsCalls = 0
    createImpl = async () => validResponse

    Client.prototype.createSystemOne = (async (
      payload: SystemOnePayload,
      options?: SystemOneOptions,
    ) => {
      createCalls.push({ payload, options })
      return createImpl(payload)
    }) as typeof Client.prototype.createSystemOne

    Client.prototype.getModels = (async (_options?: GetModelsOptions) => {
      getModelsCalls++
      return buildModelsResponse(decisionModel())
    }) as typeof Client.prototype.getModels
  })

  afterEach(() => {
    Client.prototype.createSystemOne = originalCreateSystemOne
    Client.prototype.getModels = originalGetModels
    clearConfig()
  })

  test('serves decisions at both the root and /v1 paths', async () => {
    const root = await post('/decisions', validBody)
    const prefixed = await post('/v1/decisions', validBody)

    expect(root.status).toBe(200)
    expect(prefixed.status).toBe(200)
    expect(await root.json()).toMatchObject({
      answers: [{
        type: 'choice',
        name: null,
        choice: true,
        confidence: 0.9,
        probabilities: [
          { value: true, probability: 0.9 },
          { value: false, probability: 0.1 },
        ],
      }],
      model: 'microsoft-decision-1',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    })
    expect(createCalls).toHaveLength(2)
    expect(createCalls[0]?.payload).toMatchObject({
      model: 'microsoft-decision-1',
      state: 'Ship the release?',
      questions: {
        q0: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { c0: 'true: Yes', c1: 'false: No' },
        },
      },
    })
  })

  test('rejects an unadvertised model before dispatch', async () => {
    const response = await post('/v1/decisions', {
      ...validBody,
      model: 'missing-model',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { param: 'model' },
    })
    expect(createCalls).toHaveLength(0)
  })

  test('rejects a model that does not advertise /v1/systemone', async () => {
    modelCache.cacheModels(buildModelsResponse(buildModel('chat-only')))

    const response = await post('/v1/decisions', {
      ...validBody,
      model: 'chat-only',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('decisions endpoint') },
    })
    expect(createCalls).toHaveLength(0)
  })

  test('admits a sparse model descriptor with no capabilities object', async () => {
    const sparse = {
      ...decisionModel(),
      capabilities: undefined,
    } as unknown as Model
    modelCache.cacheModels(buildModelsResponse(sparse))

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(200)
    expect(createCalls).toHaveLength(1)
  })

  test('normalizes a dot-aliased model to the advertised id', async () => {
    const response = await post('/v1/decisions', {
      ...validBody,
      model: 'microsoft.decision.1',
    })

    expect(response.status).toBe(200)
    expect(createCalls[0]?.payload.model).toBe('microsoft-decision-1')
  })

  test('dispatches with the effective model after a configured rewrite', async () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = [{ from: 'my-decision', to: 'microsoft-decision-1' }]

    const response = await post('/v1/decisions', {
      ...validBody,
      model: 'my-decision',
    })

    expect(response.status).toBe(200)
    expect(createCalls[0]?.payload.model).toBe('microsoft-decision-1')
  })

  test('rejects a configured rewrite to a chat-only model', async () => {
    modelCache.cacheModels(buildModelsResponse(decisionModel(), buildModel('chat-only')))
    const config = getCachedConfig() as Record<string, unknown>
    config.modelRewrites = [{ from: 'my-model', to: 'chat-only' }]

    const response = await post('/v1/decisions', {
      ...validBody,
      model: 'my-model',
    })

    expect(response.status).toBe(400)
    expect(createCalls).toHaveLength(0)
  })

  test('preserves a catalog failure status before inference', async () => {
    modelCache.clearModels()
    Client.prototype.getModels = (async () => {
      throw new HTTPError(502, {
        error: { message: 'catalog down', type: 'server_error' },
      })
    }) as typeof Client.prototype.getModels

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(502)
    expect(createCalls).toHaveLength(0)
  })

  test('does not load the model catalog for a structurally invalid request', async () => {
    modelCache.clearModels()

    const response = await post('/v1/decisions', {
      ...validBody,
      questions: [{
        type: 'choice',
        instructions: [{
          type: 'input_image',
          image_url: 'https://example.com/a.png',
        }],
        choices: validBody.questions[0].choices,
      }],
    })

    expect(response.status).toBe(400)
    expect(getModelsCalls).toBe(0)
    expect(createCalls).toHaveLength(0)
  })

  test('returns a bounded 400 for deeply nested JSON evidence', async () => {
    let data = '"leaf"'
    for (let index = 0; index < 100_000; index++)
      data = `{"data":${data}}`
    const body = `{"model":"${validBody.model}","input":"probe","questions":[{"type":"predicate","instructions":[{"type":"input_json","data":${data}}]}]}`

    const response = await post('/v1/decisions', body)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        details: [{ message: expect.stringContaining('exceeds 32 container levels') }],
      },
    })
    expect(createCalls).toHaveLength(0)
  })

  test('rejects duplicate choice values before catalog work', async () => {
    modelCache.clearModels()

    const response = await post('/v1/decisions', {
      ...validBody,
      questions: [{
        type: 'choice',
        instructions: 'Pick one.',
        choices: [
          { value: true, description: 'Yes' },
          { value: true, description: 'Yes again' },
        ],
      }],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'translation_error',
        code: 'invalid_decisions_choice',
      },
    })
    expect(getModelsCalls).toBe(0)
    expect(createCalls).toHaveLength(0)
  })

  test('loads an empty model catalog once before discovery', async () => {
    modelCache.clearModels()

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(200)
    expect(getModelsCalls).toBe(1)
    expect(createCalls).toHaveLength(1)
  })

  test('does not dispatch after the client signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const request = new Request('http://localhost/v1/decisions', {
      method: 'POST',
      signal: controller.signal,
    })
    runtimeStore.requests.start({
      requestId: 'aborted-decision',
      accountName: 'default',
      method: 'POST',
      endpoint: '/v1/decisions',
    })
    let called = false
    const client = {
      createSystemOne: async () => {
        called = true
        return validResponse
      },
    } as unknown as CopilotClient

    let error: unknown
    try {
      await handleDecisionsCore({
        body: validBody,
        signal: controller.signal,
        headers: new Headers({ 'content-type': 'application/json' }),
        request,
        requestId: 'aborted-decision',
        client,
      })
    }
    catch (caught) {
      error = caught
    }

    expect(isClientAbortError(error)).toBe(true)
    expect(called).toBe(false)
    expect(runtimeStore.requests.snapshot().active.find(
      request => request.requestId === 'aborted-decision',
    )?.state).toBe('aborted')
    runtimeStore.requests.complete('aborted-decision', 500)
  })

  test('maps a malformed upstream body to a translation failure', async () => {
    createImpl = async () => ({})

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'translation_error',
        code: 'invalid_upstream_decisions_response',
      },
    })
  })

  test('maps a non-JSON upstream body to a translation failure', async () => {
    createImpl = async () => {
      throw new SyntaxError('unexpected token')
    }

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: {
        message: 'Upstream decisions response was not valid JSON.',
        type: 'translation_error',
        code: 'invalid_upstream_decisions_response',
      },
    })
  })

  test('passes through a normalized upstream 422', async () => {
    createImpl = async () => {
      throw new HTTPError(422, {
        error: {
          message: 'questions[0]: bad question',
          type: 'invalid_request_error',
          param: 'questions[0]',
        },
      })
    }

    const response = await post('/v1/decisions', validBody)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { param: 'questions[0]' },
    })
  })

  test('records both paths and the effective model in the request store', async () => {
    const app = createServer()
    const requestIds: Array<string> = []

    for (const path of ['/decisions', '/v1/decisions']) {
      const response = await app.handle(new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...validBody,
          model: 'microsoft.decision.1',
        }),
      }))

      expect(response.status).toBe(200)
      const requestId = response.headers.get('x-request-id')
      expect(requestId).toBeTruthy()
      requestIds.push(requestId!)
      await response.text()
    }

    await new Promise(resolve => setImmediate(resolve))
    const recent = runtimeStore.requests.snapshot().recent
    for (const [index, path] of ['/decisions', '/v1/decisions'].entries()) {
      expect(recent.find(request => request.requestId === requestIds[index])).toMatchObject({
        endpoint: path,
        requestedModel: 'microsoft.decision.1',
        effectiveModel: 'microsoft-decision-1',
        state: 'completed',
      })
    }
  })
})
