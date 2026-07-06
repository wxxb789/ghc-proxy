import type { CapturedResponsesCall } from './helpers'
import type { Model, ResponsesPayload } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { modelCache } from '~/state'
import {
  applyResponsesParameterFilters,
  isReasoningModel,
  resolveStrippedResponsesParams,
} from '~/transform/parameter-filter'

import {
  buildGptModel,
  buildModelsResponse,
  clearConfig,
  createApp,
  mockResponses,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

function reasoningModel(id: string, overrides?: Partial<Model>): Model {
  const model = buildGptModel(id, { supported_endpoints: ['/responses'], ...overrides })
  model.capabilities.supports.reasoning_effort = ['low', 'medium', 'high']
  return model
}

describe('parameter-filter unit', () => {
  beforeEach(() => clearConfig())
  afterEach(() => clearConfig())

  test('isReasoningModel is true only when reasoning_effort is advertised', () => {
    expect(isReasoningModel(reasoningModel('gpt-5.4-mini'))).toBe(true)
    expect(isReasoningModel(buildGptModel('gpt-4.1'))).toBe(false)
    expect(isReasoningModel(undefined)).toBe(false)
  })

  test('default rule strips sampling params for reasoning models', () => {
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_p'])
  })

  test('default rule leaves non-reasoning models untouched', () => {
    expect(resolveStrippedResponsesParams(buildGptModel('gpt-4.1')).size).toBe(0)
  })

  test('user rules ADD params on top of the default (union)', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFilters = [
      { models: ['gpt-5*'], params: ['top_k'] },
    ]
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip].toSorted()).toEqual(['temperature', 'top_k', 'top_p'])
  })

  test('user rules apply to non-reasoning models via glob match', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFilters = [
      { models: ['gpt-4.1'], params: ['temperature'] },
    ]
    const strip = resolveStrippedResponsesParams(buildGptModel('gpt-4.1'))
    expect([...strip]).toEqual(['temperature'])
  })

  test('replaceDefault disables the built-in rule, leaving only user rules', () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiParameterFiltersReplaceDefault = true
    config.responsesApiParameterFilters = [
      { models: ['gpt-5*'], params: ['top_p'] },
    ]
    const strip = resolveStrippedResponsesParams(reasoningModel('gpt-5.4-mini'))
    expect([...strip]).toEqual(['top_p'])
  })

  test('applyResponsesParameterFilters deletes keys entirely, never nulls them', () => {
    const payload: ResponsesPayload = {
      model: 'gpt-5.4-mini',
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 100,
    }
    applyResponsesParameterFilters(payload, reasoningModel('gpt-5.4-mini'))
    expect('temperature' in payload).toBe(false)
    expect('top_p' in payload).toBe(false)
    expect(payload.max_output_tokens).toBe(100)
  })

  test('applyResponsesParameterFilters is a no-op for non-reasoning models', () => {
    const payload: ResponsesPayload = { model: 'gpt-4.1', temperature: 0.7, top_p: 0.9 }
    applyResponsesParameterFilters(payload, buildGptModel('gpt-4.1'))
    expect(payload.temperature).toBe(0.7)
    expect(payload.top_p).toBe(0.9)
  })
})

describe('parameter-filter native /responses integration', () => {
  const originalCreateResponses = CopilotClient.prototype.createResponses
  const stateSnapshot = saveStateSnapshot()

  beforeEach(() => {
    setupDefaultTestState()
    clearConfig()
  })

  afterEach(() => {
    CopilotClient.prototype.createResponses = originalCreateResponses
    restoreStateSnapshot(stateSnapshot)
    clearConfig()
  })

  function mockUpstream(calls: Array<CapturedResponsesCall>): void {
    CopilotClient.prototype.createResponses = mockResponses({
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      model: 'gpt-5.4-mini',
      output: [],
      output_text: 'ok',
      status: 'completed',
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    }, calls)
  }

  test('strips temperature/top_p for a reasoning model before forwarding', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(reasoningModel('gpt-5.4-mini')))
    mockUpstream(calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        temperature: 0.7,
        top_p: 0.9,
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload).toBeDefined()
    expect('temperature' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
    expect('top_p' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
  })

  test('keeps sampling params for a non-reasoning model', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-4.1', { supported_endpoints: ['/responses'] }),
    ))
    mockUpstream(calls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        temperature: 0.7,
      }),
    }))

    expect(response.status).toBe(200)
    expect(calls[0]?.payload.temperature).toBe(0.7)
  })

  test('runs after context_management injection so a user rule can strip it', async () => {
    const app = createApp()
    const calls: Array<CapturedResponsesCall> = []
    modelCache.cacheModels(buildModelsResponse(
      buildGptModel('gpt-5.4-mini', { supported_endpoints: ['/responses'] }),
    ))
    mockUpstream(calls)

    const config = getCachedConfig() as Record<string, unknown>
    config.responsesApiAutoContextManagement = true
    config.responsesApiContextManagementModels = ['gpt-5.4-mini']
    config.responsesApiParameterFilters = [
      { models: ['gpt-5.4-mini'], params: ['context_management'] },
    ]

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)
    expect('context_management' in (calls[0]!.payload as ResponsesPayload)).toBe(false)
  })
})
