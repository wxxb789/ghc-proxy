import type { CapturedEmbeddingCall } from './helpers'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CopilotClient } from '~/clients'

import {
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
