import type { Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { configureUpstreamRequestQueue } from '~/clients/factory'
import { createServer } from '~/server'
import { modelCache, runtimeStore } from '~/state'

import {
  buildModel,
  buildModelsResponse,
  clearConfig,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalFetch = globalThis.fetch

let snapshot: ReturnType<typeof saveStateSnapshot>

beforeEach(() => {
  snapshot = saveStateSnapshot()
  clearConfig()
  setupDefaultTestState()
  runtimeStore.requests.reset()
  configureUpstreamRequestQueue({
    concurrency: 10,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 1,
    maxQueueDepth: 1_000,
    recoveryBudgetMs: 1_000,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  configureUpstreamRequestQueue({
    concurrency: 10,
    maxRetries: 1,
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
    maxQueueDepth: 1_000,
    recoveryBudgetMs: 60_000,
  })
  runtimeStore.requests.reset()
  clearConfig()
  restoreStateSnapshot(snapshot)
})

async function settleResponse(response: Response): Promise<void> {
  await response.text()
  await new Promise(resolve => setTimeout(resolve, 50))
}

function installCapacityRetry(successBody: unknown): () => number {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      return Response.json(
        { error: { message: 'temporarily overloaded', type: 'overloaded_error' } },
        { status: 529, headers: { 'retry-after': '0' } },
      )
    }
    return Response.json(successBody)
  }) as unknown as typeof fetch
  return () => calls
}

function expectCorrelatedRecovery(
  endpoint: string,
  effects: ReadonlyArray<{
    id: 'recovery.cooldown' | 'recovery.retry'
    count: number
  }> = [
    { id: 'recovery.cooldown', count: 1 },
    { id: 'recovery.retry', count: 1 },
  ],
): void {
  expect(runtimeStore.requests.snapshot().recent[0]).toMatchObject({
    endpoint,
    effects: expect.arrayContaining(effects),
  })
}

describe('non-pipeline request recovery correlation', () => {
  test('attributes embedding queue effects to the active HTTP request', async () => {
    const calls = installCapacityRetry({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })

    const response = await createServer().handle(new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
    }))
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(calls()).toBe(2)
    expectCorrelatedRecovery('/v1/embeddings')
  })

  test('attributes model cache-miss queue effects to the active HTTP request', async () => {
    modelCache.clearModels()
    const model: Model = buildModel('claude-sonnet-4.5')
    const calls = installCapacityRetry(buildModelsResponse(model))

    const response = await createServer().handle(
      new Request('http://localhost/v1/models'),
    )
    await settleResponse(response)

    expect(response.status).toBe(200)
    expect(calls()).toBe(2)
    expectCorrelatedRecovery('/v1/models')
  })

  const resourceCases = [
    {
      name: 'retrieve',
      endpoint: '/v1/responses/:responseId',
      request: () => new Request('http://localhost/v1/responses/resp_123'),
      successBody: { id: 'resp_123', object: 'response' },
      expectedCalls: 2,
      expectedStatus: 200,
      expectedEffects: [
        { id: 'recovery.cooldown', count: 1 },
        { id: 'recovery.retry', count: 1 },
      ],
    },
    {
      name: 'list input items',
      endpoint: '/v1/responses/:responseId/input_items',
      request: () => new Request('http://localhost/v1/responses/resp_123/input_items'),
      successBody: { object: 'list', data: [], first_id: null, last_id: null, has_more: false },
      expectedCalls: 2,
      expectedStatus: 200,
      expectedEffects: [
        { id: 'recovery.cooldown', count: 1 },
        { id: 'recovery.retry', count: 1 },
      ],
    },
    {
      name: 'count input tokens',
      endpoint: '/v1/responses/input_tokens',
      request: () => new Request('http://localhost/v1/responses/input_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: [{ type: 'message', role: 'user', content: 'hello' }],
        }),
      }),
      successBody: { object: 'response.input_tokens', input_tokens: 1 },
      expectedCalls: 2,
      expectedStatus: 200,
      expectedEffects: [
        { id: 'recovery.cooldown', count: 1 },
        { id: 'recovery.retry', count: 1 },
      ],
    },
    {
      name: 'delete',
      endpoint: '/v1/responses/:responseId',
      request: () => new Request('http://localhost/v1/responses/resp_123', {
        method: 'DELETE',
      }),
      successBody: { id: 'resp_123', object: 'response.deleted', deleted: true },
      expectedCalls: 1,
      expectedStatus: 529,
      expectedEffects: [{ id: 'recovery.cooldown', count: 1 }],
    },
  ] as const

  for (const resourceCase of resourceCases) {
    test(`attributes ${resourceCase.name} queue effects to the active HTTP request`, async () => {
      const calls = installCapacityRetry(resourceCase.successBody)

      const response = await createServer().handle(resourceCase.request())
      await settleResponse(response)

      expect(response.status).toBe(resourceCase.expectedStatus)
      expect(calls()).toBe(resourceCase.expectedCalls)
      expectCorrelatedRecovery(resourceCase.endpoint, resourceCase.expectedEffects)
    })
  }
})
