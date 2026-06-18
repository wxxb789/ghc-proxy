import type { CapturedEmbeddingCall } from './helpers'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import consola from 'consola'
import { CopilotClient } from '~/clients'
import { UpstreamRequestQueue } from '~/clients/upstream-queue'

import {
  createApp,
  mockEmbeddings,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalCreateEmbeddings = CopilotClient.prototype.createEmbeddings
const originalConsolaError = consola.error
const stateSnapshot = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
})

afterEach(() => {
  CopilotClient.prototype.createEmbeddings = originalCreateEmbeddings
  consola.error = originalConsolaError
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

describe('embeddings upstream diagnostics', () => {
  test('logs upstream status and empty body details', async () => {
    const errorLogs: Array<unknown[]> = []
    consola.error = ((...args: unknown[]) => {
      errorLogs.push(args)
    }) as typeof consola.error

    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () =>
          new Response('', {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'content-type': 'text/plain' },
          })) as unknown) as typeof fetch,
      },
    )

    await expect(
      client.createEmbeddings({
        model: 'text-embedding-3-small',
        input: ['hello'],
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: {
        error: {
          message: 'Failed to create embeddings',
          type: 'upstream_error',
        },
      },
    })

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]?.[0]).toBe('Upstream error:')
    expect(errorLogs[0]?.[1]).toMatchObject({
      status: 400,
      statusText: 'Bad Request',
      rawBody: '<empty>',
    })
  })

  test('preserves plain text upstream rate limit errors', async () => {
    const errorLogs: Array<unknown[]> = []
    consola.error = ((...args: unknown[]) => {
      errorLogs.push(args)
    }) as typeof consola.error

    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        fetch: ((async () =>
          new Response('too many requests\n', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'content-type': 'text/plain' },
          })) as unknown) as typeof fetch,
      },
    )

    await expect(
      client.createEmbeddings({
        model: 'text-embedding-3-small',
        input: ['hello'],
      }),
    ).rejects.toMatchObject({
      status: 429,
      body: {
        error: {
          message: 'too many requests',
          type: 'rate_limit_error',
        },
      },
    })

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]?.[1]).toMatchObject({
      status: 429,
      statusText: 'Too Many Requests',
      body: {
        error: {
          message: 'too many requests',
          type: 'rate_limit_error',
        },
      },
      rawBody: 'too many requests\n',
    })
  })

  test('retries queued upstream rate limit responses before surfacing success', async () => {
    let now = 1_000
    const requestQueue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 1,
        baseDelayMs: 25,
        maxDelayMs: 25,
      },
      {
        now: () => now,
        sleep: (ms) => {
          now += ms
          return Promise.resolve()
        },
        logger: {
          warn: () => {},
        },
        setTimeout: ((_callback: () => void) => {
          return undefined as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )
    let calls = 0
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', vsCodeVersion: '1.99.0' },
      {
        requestQueue,
        fetch: ((async () => {
          calls++
          if (calls === 1) {
            return new Response('too many requests\n', {
              status: 429,
              statusText: 'Too Many Requests',
            })
          }
          return Response.json({
            object: 'list',
            data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 1, total_tokens: 1 },
          })
        }) as unknown) as typeof fetch,
      },
    )

    const response = await client.createEmbeddings({
      model: 'text-embedding-3-small',
      input: ['hello'],
    })

    expect(response.data).toHaveLength(1)
    expect(calls).toBe(2)
  })
})
