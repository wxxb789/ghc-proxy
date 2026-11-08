import type { CapturedEmbeddingCall } from './helpers'
import type { EmbeddingRequest, EmbeddingResponse } from '~/types'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CopilotClient } from '~/clients'
import { isClientAbortError } from '~/lib/upstream-signal'
import { handleEmbeddingsCore } from '~/routes/embeddings/handler'
import { handleModelsCore } from '~/routes/models/handler'
import {
  handleCreateResponseInputTokensCore,
  handleDeleteResponseCore,
  handleListResponseInputItemsCore,
  handleRetrieveResponseCore,
} from '~/routes/responses/resource-handler'
import { modelCache } from '~/state'

import {
  buildModel,
  buildModelsResponse,
  createApp,
  mockEmbeddings,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalCreateEmbeddings = CopilotClient.prototype.createEmbeddings
const stateSnapshot = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
})

afterEach(() => {
  CopilotClient.prototype.createEmbeddings = originalCreateEmbeddings
  restoreStateSnapshot(stateSnapshot)
})

describe('embeddings route', () => {
  test('normalizes string input to array before forwarding upstream', async () => {
    const app = createApp('embeddings')
    const calls: Array<CapturedEmbeddingCall> = []

    CopilotClient.prototype.createEmbeddings = mockEmbeddings({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.input).toEqual(['hello'])
  })

  test('preserves array input and optional embedding fields', async () => {
    const app = createApp('embeddings')
    const calls: Array<CapturedEmbeddingCall> = []

    CopilotClient.prototype.createEmbeddings = mockEmbeddings({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }, calls)

    const response = await app.handle(new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: ['hello', 'world'],
        dimensions: 256,
        encoding_format: 'float',
        user: 'user-123',
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toEqual({
      model: 'text-embedding-3-small',
      input: ['hello', 'world'],
      dimensions: 256,
      encoding_format: 'float',
      user: 'user-123',
    })
  })
})

// The routes that bypass runPipeline construct their own CopilotClient, which
// left prototype patching as the only way to intercept them. Each now accepts
// an optional client so a test can hand in a stand-in directly. These tests
// exercise that seam — note the absence of any CopilotClient.prototype write.

describe('client injection for non-pipeline handlers', () => {
  test('handleEmbeddingsCore uses an injected client', async () => {
    const calls: Array<CapturedEmbeddingCall> = []
    const client = {
      createEmbeddings: (payload: EmbeddingRequest) => {
        calls.push({ payload })
        return Promise.resolve({
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        } satisfies EmbeddingResponse)
      },
    } as unknown as CopilotClient

    const result = await handleEmbeddingsCore(
      { model: 'text-embedding-3-small', input: 'hello' },
      new Headers({ 'content-type': 'application/json' }),
      client,
    )

    expect(calls).toHaveLength(1)
    // Normalization still applies on the injected path.
    expect(calls[0]?.payload.input).toEqual(['hello'])
    expect(result).toMatchObject({ object: 'list' })
  })

  // Regression: createEmbeddings had no signal parameter at all, and this
  // route does not go through runPipeline (where the upstream signal is
  // wired), so a client disconnect left the upstream request running and the
  // configured upstream timeout had nothing to act on.
  test('handleEmbeddingsCore forwards an abort signal to the client', async () => {
    const controller = new AbortController()
    let abortedDuringCall: boolean | undefined

    const client = {
      createEmbeddings: async (_payload: EmbeddingRequest, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal
        if (!signal) {
          throw new Error('no signal reached the client')
        }
        // Abort while the upstream call is still in flight — that is the
        // window a client disconnect actually falls in.
        expect(signal.aborted).toBe(false)
        controller.abort()
        abortedDuringCall = signal.aborted

        return {
          object: 'list',
          model: 'text-embedding-3-small',
          data: [],
          usage: { prompt_tokens: 0, total_tokens: 0 },
        } satisfies EmbeddingResponse
      },
    } as unknown as CopilotClient

    await handleEmbeddingsCore(
      { model: 'text-embedding-3-small', input: 'hello' },
      new Headers({ 'content-type': 'application/json' }),
      client,
      controller.signal,
    )

    expect(abortedDuringCall).toBe(true)
  })

  test('handleModelsCore uses an injected client on a cache miss', async () => {
    modelCache.clearModels()
    let getModelsCalls = 0
    const client = {
      getModels: () => {
        getModelsCalls++
        return Promise.resolve(buildModelsResponse(buildModel('claude-opus-4.6')))
      },
    } as unknown as CopilotClient

    const result = await handleModelsCore(client) as { data: Array<{ id: string }> }

    expect(getModelsCalls).toBe(1)
    expect(result.data.map(model => model.id)).toEqual(['claude-opus-4.6'])
  })

  test('handleRetrieveResponseCore uses an injected client', async () => {
    const calls: Array<string> = []
    const client = {
      getResponse: (responseId: string) => {
        calls.push(responseId)
        return Promise.resolve({ id: responseId, object: 'response' })
      },
    } as unknown as CopilotClient

    const result = await handleRetrieveResponseCore({
      params: { responseId: 'resp_injected' },
      url: 'http://localhost/v1/responses/resp_injected',
      headers: new Headers(),
      signal: new AbortController().signal,
      client,
    })

    expect(calls).toEqual(['resp_injected'])
    expect(result).toMatchObject({ id: 'resp_injected' })
  })
})

// `createUpstreamSignal` deliberately ignores a client signal that is already
// aborted when it is created, so a route that bypasses runPipeline must refuse
// dispatch itself. Embeddings, the `/responses/{id}` resource handlers and the
// models cache miss used to skip that check and spend an upstream call on a
// caller that was already gone.

describe('direct routes refuse a caller that already aborted', () => {
  interface DirectRouteCase {
    name: string
    run: (client: CopilotClient, signal: AbortSignal, onClientAbort: () => void) => Promise<unknown>
  }

  const headers = () => new Headers({ 'content-type': 'application/json' })
  const cases: Array<DirectRouteCase> = [
    {
      name: 'embeddings',
      run: (client, signal, onClientAbort) => handleEmbeddingsCore(
        { model: 'text-embedding-3-small', input: 'hello' },
        headers(),
        client,
        signal,
        undefined,
        onClientAbort,
      ),
    },
    {
      name: 'retrieve response',
      run: (client, signal, onClientAbort) => handleRetrieveResponseCore({
        params: { responseId: 'resp_1' },
        url: 'http://localhost/v1/responses/resp_1',
        headers: headers(),
        signal,
        client,
        onClientAbort,
      }),
    },
    {
      name: 'list response input items',
      run: (client, signal, onClientAbort) => handleListResponseInputItemsCore({
        params: { responseId: 'resp_1' },
        url: 'http://localhost/v1/responses/resp_1/input_items',
        headers: headers(),
        signal,
        client,
        onClientAbort,
      }),
    },
    {
      name: 'response input tokens',
      run: (client, signal, onClientAbort) => handleCreateResponseInputTokensCore({
        body: { model: 'gpt-5', input: 'hello' },
        headers: headers(),
        signal,
        client,
        onClientAbort,
      }),
    },
    {
      name: 'delete response',
      run: (client, signal, onClientAbort) => handleDeleteResponseCore({
        params: { responseId: 'resp_1' },
        headers: headers(),
        signal,
        client,
        onClientAbort,
      }),
    },
    {
      name: 'models cache miss',
      run: (client, signal, onClientAbort) => {
        modelCache.clearModels()
        return handleModelsCore(client, undefined, signal, onClientAbort)
      },
    },
  ]

  for (const { name, run } of cases) {
    test(`${name} does not call upstream`, async () => {
      const upstreamCalls: Array<string> = []
      const client = new Proxy({}, {
        get: (_target, method) => () => {
          upstreamCalls.push(String(method))
          return Promise.resolve({})
        },
      }) as CopilotClient
      const controller = new AbortController()
      controller.abort()
      let clientAborts = 0

      let error: unknown
      try {
        await run(client, controller.signal, () => clientAborts++)
      }
      catch (caught) {
        error = caught
      }

      expect(isClientAbortError(error)).toBe(true)
      expect(upstreamCalls).toEqual([])
      expect(clientAborts).toBe(1)
    })
  }
})
