import type { RuntimeListener } from '~/lib/server-runtime'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { UpstreamRequestQueue } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import { createRuntimeApp, listenRuntimeServer } from '~/lib/server-runtime'
import { createImageRoutes } from '~/routes/images/route'
import { modelCache } from '~/state'

import { buildModel, buildModelsResponse, clearConfig, parseSse, restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

const originalConfig = structuredClone(getCachedConfig())
const originalState = saveStateSnapshot()
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const imageBytes = Uint8Array.from(atob(imageBase64), character => character.charCodeAt(0))

beforeEach(() => {
  setupDefaultTestState()
  clearConfig()
  getCachedConfig().modelRewrites = [{ from: 'image-alias', to: 'image-model' }]
  modelCache.cacheModels(buildModelsResponse(buildModel('image-model', {
    supported_endpoints: ['/v1/images/generations', '/v1/images/edits'],
  })))
})

afterEach(() => {
  restoreStateSnapshot(originalState)
  clearConfig()
  Object.assign(getCachedConfig(), structuredClone(originalConfig))
})

async function withImageServer(
  respond: (request: Request) => Response | Promise<Response>,
  check: (origin: string, queue: UpstreamRequestQueue) => Promise<void>,
): Promise<void> {
  const upstream = await listenRuntimeServer(
    createRuntimeApp().post('/v1/images/:operation', ({ request }) => respond(request), { parse: 'none' }),
    { hostname: '127.0.0.1', port: 0 },
  )
  let proxy: RuntimeListener | undefined
  try {
    const queue = new UpstreamRequestQueue({ concurrency: 1 })
    const client = new CopilotClient(
      { copilotToken: 'test-token' },
      { accountType: 'individual', copilotApiBase: upstream.url.origin },
      { requestQueue: queue },
    )
    proxy = await listenRuntimeServer(
      createRuntimeApp().use(createImageRoutes(client)),
      { hostname: '127.0.0.1', port: 0 },
    )
    await check(proxy.url.origin, queue)
  }
  finally {
    await proxy?.close(true)
    await upstream.close(true)
  }
}

describe('image route success', () => {
  test('generations resolves the model alias and returns Images JSON while releasing admission', async () => {
    await withImageServer(async (request) => {
      expect(new URL(request.url).pathname).toBe('/v1/images/generations')
      expect(request.headers.get('authorization')).toBe('Bearer test-token')
      const body = await request.json() as { model: string }
      expect(body.model).toBe('image-model')
      return Response.json({
        created: 42,
        data: [{ b64_json: imageBase64 }],
        usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      })
    }, async (origin, queue) => {
      const response = await fetch(`${origin}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'image-alias', prompt: 'A watercolor fox' }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({
        created: 42,
        data: [{ b64_json: imageBase64 }],
        usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      })
      expect(queue.snapshot().active).toBe(0)
    })
  })

  test('edits uploads images and a mask and retains admission until the completed SSE event', async () => {
    const finish = Promise.withResolvers<void>()
    const partial = { type: 'image_edit.partial_image', partial_image_index: 0, b64_json: imageBase64 }
    const completed = { type: 'image_edit.completed', created_at: 42, b64_json: imageBase64 }
    const encoder = new TextEncoder()

    try {
      await withImageServer(async (request) => {
        expect(new URL(request.url).pathname).toBe('/v1/images/edits')
        expect(request.headers.get('content-type')).toContain('multipart/form-data; boundary=')
        const body = await request.formData()
        expect(body.get('model')).toBe('image-model')
        const images = body.getAll('image[]')
        expect(images).toHaveLength(2)
        for (const [index, image] of images.entries()) {
          if (typeof image === 'string')
            throw new TypeError('Expected an uploaded image')
          expect(image.name).toBe(`source-${index}.png`)
          expect(image.type).toBe('image/png')
          expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBytes)
        }
        const mask = body.get('mask')
        if (!mask || typeof mask === 'string')
          throw new TypeError('Expected an uploaded mask')
        expect(new Uint8Array(await mask.arrayBuffer())).toEqual(imageBytes)

        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`id: image-0\nevent: image_edit.partial_image\ndata: ${JSON.stringify(partial)}\n\n`))
            await finish.promise
            controller.enqueue(encoder.encode(`id: image-1\nevent: image_edit.completed\ndata: ${JSON.stringify(completed)}\n\n`))
            controller.close()
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }, async (origin, queue) => {
        const body = new FormData()
        body.append('model', 'image-alias')
        body.append('prompt', 'Replace the background')
        body.append('stream', 'true')
        body.append('image[]', new File([imageBytes], 'source-0.png', { type: 'image/png' }))
        body.append('image[]', new File([imageBytes], 'source-1.png', { type: 'image/png' }))
        body.append('mask', new File([imageBytes], 'mask.png', { type: 'image/png' }))
        const response = await fetch(`${origin}/images/edits`, { method: 'POST', body })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let text = ''
        while (!/\r?\n\r?\n/.test(text)) {
          const next = await reader.read()
          if (next.done)
            throw new Error('Image stream ended before its partial event')
          text += decoder.decode(next.value, { stream: true })
        }
        expect(parseSse(text)).toEqual([{ event: partial.type, data: JSON.stringify(partial) }])
        expect(queue.snapshot().active).toBe(1)

        finish.resolve()
        for (;;) {
          const next = await reader.read()
          if (next.done)
            break
          text += decoder.decode(next.value, { stream: true })
        }
        text += decoder.decode()
        expect(parseSse(text)).toEqual([
          { event: partial.type, data: JSON.stringify(partial) },
          { event: completed.type, data: JSON.stringify(completed) },
        ])
        expect(text).toContain('id: image-0')
        expect(text).toContain('id: image-1')
        expect(queue.snapshot().active).toBe(0)
      })
    }
    finally {
      finish.resolve()
    }
  })
})
