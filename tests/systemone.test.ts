import type { CapturedDecisionsCall, StateSnapshot } from './helpers'

import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { handleSystemOneCore } from '~/routes/systemone/handler'
import { createServer } from '~/server'
import { modelCache, runtimeStore } from '~/state'

import { buildModel, buildModelsResponse, mockSystemOne, restoreStateSnapshot, saveStateSnapshot, setupDefaultTestState } from './helpers'

const originalFetch = globalThis.fetch
const originalCreateSystemOne = CopilotClient.prototype.createSystemOne
const originalGetModels = CopilotClient.prototype.getModels
const models = buildModelsResponse(buildModel('microsoft-decision-1', { supported_endpoints: ['/v1/systemone'] }))
const body = { model: 'microsoft-decision-1', state: 'evidence', questions: { q0: { type: 'noul' } } }
const upstream = {
  model: 'microsoft-decision-1.1',
  answers: { q0: { type: 'noul' as const, noul: 1 } },
  usage: { input_tokens: 10, output_tokens: 0 },
}

function post(payload: unknown, path = '/v1/systemone') {
  return createServer().handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

describe('System One route', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
    setupDefaultTestState()
    modelCache.cacheModels(models)
    runtimeStore.requests.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    CopilotClient.prototype.createSystemOne = originalCreateSystemOne
    CopilotClient.prototype.getModels = originalGetModels
    restoreStateSnapshot(snapshot)
    runtimeStore.requests.reset()
  })

  test('preserves arbitrary keys and response fields while recording the effective model', async () => {
    const state: unknown = JSON.parse('{"__proto__":{"nested":[null,true,42]}}')
    const questions: unknown = JSON.parse('{"__proto__":{"type":"choice","criteria":{"__proto__":null,"yes":"approve"}},"score":{"type":"score","criteria":["low","high"]},"box":{"type":"noul"},"refused":{"type":"noul","criteria":null}}')
    const reply = {
      ...upstream,
      marker: 'extension',
      answers: {
        ['__proto__']: { type: 'choice', choice: '__proto__', probabilities: { ['__proto__']: 0.8, yes: 0.2 }, confidence: 0.8 },
        score: { type: 'score', score: 0.7, confidence: 0.8, probabilities: { 0: 0.3, 1: 0.7 }, legend: { 0: 'low', 1: 'high' } },
        box: { type: 'box', box: { top: 0, bottom: 3, left: 1, right: 2 }, confidence: null },
        refused: { type: 'refusal', reason: 'extension' },
      },
    }
    const calls: Array<CapturedDecisionsCall> = []
    CopilotClient.prototype.createSystemOne = mockSystemOne(reply, calls)
    const response = await post({ model: 'microsoft.decision.1', state, questions }, '/systemone')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(reply)
    expect(calls.map(call => JSON.stringify(call.payload))).toEqual([JSON.stringify({ model: body.model, state, questions })])
    expect(Object.hasOwn(calls[0]!.payload.questions, '__proto__')).toBe(true)
    await setImmediate()
    expect(runtimeStore.requests.snapshot().recent.find(request => request.requestId === response.headers.get('x-request-id'))).toMatchObject({
      endpoint: '/systemone',
      requestedModel: 'microsoft.decision.1',
      effectiveModel: body.model,
      state: 'completed',
    })
  })

  test('does not load the catalog for an invalid payload; loads it for the next valid request', async () => {
    modelCache.clearModels()
    let catalogLoads = 0
    CopilotClient.prototype.getModels = async () => {
      catalogLoads++
      return models
    }
    const calls: Array<CapturedDecisionsCall> = []
    CopilotClient.prototype.createSystemOne = mockSystemOne(upstream, calls)

    const invalid = await post({ ...body, stream: false })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(catalogLoads).toBe(0)
    expect(calls).toHaveLength(0)
    expect((await post({ ...body, state: [true, null, 2, {}] })).status).toBe(200)
    expect(catalogLoads).toBe(1)
    expect(calls[0]?.payload.state).toEqual([true, null, 2, {}])
  })

  test.each([false, true])('coalesces cold catalog loads without inheriting the first caller abort (%s)', async (abortFirst) => {
    modelCache.clearModels()
    const firstStarted = Promise.withResolvers<void>()
    const firstLoad = Promise.withResolvers<typeof models>()
    const firstCaller = new AbortController()
    let catalogLoads = 0
    CopilotClient.prototype.getModels = async (options) => {
      if (++catalogLoads !== 1)
        return models
      const signal = options?.signal
      signal?.addEventListener('abort', () => firstLoad.reject(signal.reason), { once: true })
      firstStarted.resolve()
      return firstLoad.promise
    }
    CopilotClient.prototype.createSystemOne = mockSystemOne(upstream, [])

    const request = new Request('http://localhost/v1/systemone', { signal: firstCaller.signal })
    const first = Promise.allSettled([handleSystemOneCore({ body, request })])
    await firstStarted.promise
    const second = handleSystemOneCore({ body, request: new Request(request.url) })
    const loadsWhilePending = catalogLoads

    if (abortFirst)
      firstCaller.abort()
    else
      firstLoad.resolve(models)

    expect(await second).toEqual(upstream)
    const [firstResult] = await first
    if (abortFirst)
      expect(firstResult).toMatchObject({ status: 'rejected', reason: { ghcProxyClientAbort: true } })
    else
      expect(firstResult).toEqual({ status: 'fulfilled', value: upstream })
    expect(loadsWhilePending).toBe(1)
    expect(catalogLoads).toBe(abortFirst ? 2 : 1)
  })

  test('rejects unknown models without inference', async () => {
    const calls: Array<CapturedDecisionsCall> = []
    CopilotClient.prototype.createSystemOne = mockSystemOne(upstream, calls)
    const response = await post({ ...body, model: 'missing' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', param: 'model' } })
    expect(calls).toHaveLength(0)
  })

  test.each([
    { label: 'missing answer', answers: {} },
    { label: 'extra answer', answers: { ...upstream.answers, extra: { type: 'refusal' } } },
    { label: 'same number of wrong keys', answers: { extra: { type: 'refusal' } } },
    { label: 'out-of-range probability', answers: { q0: { type: 'noul', noul: 1.1 } } },
    { label: 'invalid probability under an own __proto__ key', answers: { q0: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { ['__proto__']: -1, yes: 1 } } } },
    { label: 'inverted box', answers: { q0: { type: 'box', box: { top: 2, bottom: 1, left: 0, right: 1 }, confidence: null } } },
  ])('returns 502 for $label', async ({ answers }) => {
    CopilotClient.prototype.createSystemOne = mockSystemOne({ ...upstream, answers }, [])
    const response = await post(body)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { type: 'translation_error', code: 'invalid_upstream_systemone_response' },
    })
  })

  test('returns a 502 translation error for a non-JSON upstream response', async () => {
    CopilotClient.prototype.createSystemOne = async () => {
      throw new SyntaxError('Not JSON')
    }
    const response = await post(body)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { type: 'translation_error', code: 'invalid_upstream_systemone_response' },
    })
  })

  test('preserves upstream status, Retry-After and native paths but drops rejected evidence', async () => {
    globalThis.fetch = Object.assign(async () => Response.json({
      detail: [
        { loc: ['body', 'questions', 'q0', 'criteria'], msg: 'bad criteria', input: 'private' },
        { loc: ['body', 'state'], msg: 'bad state', input: { secret: true } },
      ],
    }, { status: 422, headers: { 'Retry-After': '11' } }), { preconnect: originalFetch.preconnect })
    const response = await post(body)
    expect(response.status).toBe(422)
    expect(response.headers.get('retry-after')).toBe('11')
    expect(await response.json()).toEqual({
      error: {
        message: 'Failed to create System One response',
        type: 'invalid_request_error',
        code: 'upstream_validation_error',
        param: 'questions.q0.criteria',
        details: [
          { path: 'questions.q0.criteria', message: 'bad criteria' },
          { path: 'state', message: 'bad state' },
        ],
      },
    })
  })

  test('tags a cancelled upstream body read as a client abort', async () => {
    const controller = new AbortController()
    const request = new Request('http://localhost/v1/systemone', { signal: controller.signal })
    CopilotClient.prototype.createSystemOne = async (_payload, options) => {
      controller.abort()
      expect(options?.signal?.aborted).toBe(true)
      throw new DOMException('interrupted body read', 'AbortError')
    }
    await expect(handleSystemOneCore({ body, request })).rejects.toMatchObject({ ghcProxyClientAbort: true })
  })
})
