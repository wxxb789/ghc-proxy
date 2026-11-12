import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { UpstreamRequestQueue } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import { createImageRoutes } from '~/routes/images/route'
import { authStore, modelCache } from '~/state'

import { buildModel, buildModelsResponse, clearConfig, parseSse, restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

const originalConfig = structuredClone(getCachedConfig())
const originalState = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
  clearConfig()
  modelCache.cacheModels(buildModelsResponse(buildModel('image-model', {
    supported_endpoints: ['/v1/images/generations', '/v1/images/edits'],
  })))
})

afterEach(() => {
  restoreStateSnapshot(originalState)
  clearConfig()
  Object.assign(getCachedConfig(), structuredClone(originalConfig))
})

describe('image stream failures', () => {
  test.each(['generations', 'edits'] as const)('%s reports a body failure after a partial image without replaying inference', async (operation) => {
    const queue = new UpstreamRequestQueue({ maxRetries: 1 })
    let attempts = 0
    const fetchImpl: typeof fetch = Object.assign(async () => {
      attempts++
      let partialSent = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (partialSent) {
            controller.error(new Error('private upstream failure details'))
            return
          }
          partialSent = true
          controller.enqueue(new TextEncoder().encode('event: image_generation.partial_image\ndata: {"partial_image_index":0}\n\n'))
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }, { preconnect: fetch.preconnect })
    const client = new CopilotClient({ copilotToken: 'test-token' }, { accountType: 'individual' }, { fetch: fetchImpl, requestQueue: queue })
    const response = await createImageRoutes(client).handle(new Request(`http://localhost/images/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-model',
        prompt: 'Draw',
        stream: true,
        ...(operation === 'edits' ? { images: [{ file_id: 'file-image' }] } : {}),
      }),
    }))

    expect(response.status).toBe(200)
    const events = parseSse(await response.text())
    expect(events[0]?.event).toBe('image_generation.partial_image')
    expect(events.at(-1)?.event).toBe('error')
    expect(JSON.parse(events.at(-1)!.data!)).toMatchObject({ error: { type: 'server_error' } })
    expect(events.at(-1)?.data).not.toContain('private upstream failure details')
    expect(queue.snapshot().active).toBe(0)
    expect(attempts).toBe(1)
  })

  test('reports timeout before the first image event instead of an empty successful stream', async () => {
    authStore.upstreamTimeoutSeconds = 0.02
    const queue = new UpstreamRequestQueue()
    const fetchImpl: typeof fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init?.signal
      if (!signal)
        throw new Error('Expected upstream cancellation signal')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }, { preconnect: fetch.preconnect })
    const client = new CopilotClient({ copilotToken: 'test-token' }, { accountType: 'individual' }, { fetch: fetchImpl, requestQueue: queue })
    const response = await createImageRoutes(client).handle(new Request('http://localhost/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'image-model', prompt: 'Draw', stream: true }),
    }))
    const events = parseSse(await response.text())

    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('error')
    expect(JSON.parse(events[0]!.data!)).toMatchObject({ error: { type: 'timeout_error' } })
    expect(queue.snapshot().active).toBe(0)
  })
})
