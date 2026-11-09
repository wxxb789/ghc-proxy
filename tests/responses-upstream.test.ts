import type { ProxyEffectId } from '~/observability/effects'
import type { Model, ResponsesPayload, ResponsesResult } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { runtimeStore } from '~/state'
import { createResponsesTerminalObservers, shapeResponsesUpstreamPayload } from '~/transform/responses-upstream'

import { buildGptModel, buildResponsesResult, clearConfig } from './helpers'

const REQUEST_ID = 'responses-upstream-test'

function reasoningModel(): Model {
  const model = buildGptModel('gpt-5.6-sol', { supported_endpoints: ['/responses'] })
  model.capabilities.supports.reasoning_effort = ['low', 'medium', 'high']
  return model
}

function plainModel(): Model {
  return buildGptModel('gpt-5.6-sol', { supported_endpoints: ['/responses'] })
}

function recordedEffects(): Partial<Record<ProxyEffectId, number>> {
  const request = runtimeStore.requests.snapshot().active.find(entry => entry.requestId === REQUEST_ID)
  return Object.fromEntries(request?.effects.map(effect => [effect.id, effect.count]) ?? [])
}

function recordedError(): string | undefined {
  return runtimeStore.requests.snapshot().active.find(entry => entry.requestId === REQUEST_ID)?.errorSummary
}

beforeEach(() => {
  clearConfig()
  runtimeStore.requests.reset()
  runtimeStore.requests.start({ requestId: REQUEST_ID, method: 'POST', endpoint: '/v1/responses' })
})

afterEach(() => {
  runtimeStore.requests.reset()
  clearConfig()
})

interface ShapingCase {
  name: string
  config?: Record<string, unknown>
  model: () => Model | undefined
  input: ResponsesPayload
  expected: ResponsesPayload
  effects: Partial<Record<ProxyEffectId, number>>
}

const shapingCases: Array<ShapingCase> = [
  {
    name: 'leaves an already-acceptable payload untouched and records nothing',
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello', max_output_tokens: 16 },
    expected: { model: 'gpt-5.6-sol', input: 'hello', max_output_tokens: 16 },
    effects: {},
  },
  {
    name: 'drops input before the latest compaction item when auto-compaction is enabled',
    config: { responsesApiAutoCompactInput: true },
    model: plainModel,
    input: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'user', content: 'old' },
        { type: 'message', role: 'user', content: 'older' },
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc' },
        { type: 'message', role: 'user', content: 'new' },
      ],
    },
    expected: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc' },
        { type: 'message', role: 'user', content: 'new' },
      ],
    },
    effects: { 'responses.input_compacted': 2 },
  },
  {
    name: 'strips phase from input message items',
    model: plainModel,
    input: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'assistant', content: 'a', phase: 'commentary' },
        { role: 'assistant', content: 'b', phase: 'final_answer' },
        { type: 'message', role: 'user', content: 'c' },
      ],
    },
    expected: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { type: 'message', role: 'user', content: 'c' },
      ],
    },
    effects: { 'responses.phase_filtered': 2 },
  },
  {
    name: 'injects context management from the model prompt limit',
    config: { responsesApiAutoContextManagement: true, responsesApiContextManagementModels: ['gpt-5.6-sol'] },
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello' },
    expected: {
      model: 'gpt-5.6-sol',
      input: 'hello',
      context_management: [{ type: 'compaction', compact_threshold: 162000 }],
    },
    effects: { 'responses.context_management': 1 },
  },
  {
    name: 'falls back to the default context-management threshold without a model',
    config: { responsesApiAutoContextManagement: true, responsesApiContextManagementModels: ['gpt-5.6-sol'] },
    model: () => undefined,
    input: { model: 'gpt-5.6-sol', input: 'hello' },
    expected: {
      model: 'gpt-5.6-sol',
      input: 'hello',
      context_management: [{ type: 'compaction', compact_threshold: 50000 }],
    },
    effects: { 'responses.context_management': 1 },
  },
  {
    name: 'strips parameters the model rejects',
    model: reasoningModel,
    input: { model: 'gpt-5.6-sol', input: 'hello', temperature: 0.5, top_p: 0.5 },
    expected: { model: 'gpt-5.6-sol', input: 'hello' },
    effects: { 'responses.parameter_filter': 2 },
  },
  {
    name: 'raises max_output_tokens to the Copilot floor',
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello', max_output_tokens: 1 },
    expected: { model: 'gpt-5.6-sol', input: 'hello', max_output_tokens: 16 },
    effects: { 'responses.output_tokens_raised': 1 },
  },
  {
    name: 'counts phases only on items that survive compaction',
    config: { responsesApiAutoCompactInput: true },
    model: plainModel,
    input: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'assistant', content: 'dropped', phase: 'final_answer' },
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc' },
        { type: 'message', role: 'assistant', content: 'kept', phase: 'commentary' },
      ],
    },
    expected: {
      model: 'gpt-5.6-sol',
      input: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc' },
        { type: 'message', role: 'assistant', content: 'kept' },
      ],
    },
    effects: { 'responses.input_compacted': 1, 'responses.phase_filtered': 1 },
  },
  {
    name: 'runs parameter filters after context management so a rule can strip the injected field',
    config: {
      responsesApiAutoContextManagement: true,
      responsesApiContextManagementModels: ['gpt-5.6-sol'],
      responsesApiParameterFilters: [{ models: ['gpt-5.6-sol'], params: ['context_management'] }],
    },
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello' },
    expected: { model: 'gpt-5.6-sol', input: 'hello' },
    effects: { 'responses.context_management': 1, 'responses.parameter_filter': 1 },
  },
  {
    name: 'runs parameter filters before the output-token clamp',
    config: { responsesApiParameterFilters: [{ models: ['gpt-5.6-sol'], params: ['max_output_tokens'] }] },
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello', max_output_tokens: 1 },
    expected: { model: 'gpt-5.6-sol', input: 'hello' },
    effects: { 'responses.parameter_filter': 1 },
  },
  {
    // The M365 gateway rejects `stream: null` with 400 "stream must be a
    // boolean" (live, 2026-11-09); omitting it means the same non-streaming
    // request on every upstream.
    name: 'omits a null stream flag',
    model: plainModel,
    input: { model: 'gpt-5.6-sol', input: 'hello', stream: null },
    expected: { model: 'gpt-5.6-sol', input: 'hello' },
    effects: {},
  },
]

describe('shapeResponsesUpstreamPayload', () => {
  for (const testCase of shapingCases) {
    test(testCase.name, () => {
      Object.assign(getCachedConfig(), testCase.config ?? {})
      const payload = structuredClone(testCase.input)

      shapeResponsesUpstreamPayload(payload, testCase.model(), REQUEST_ID)

      expect(payload).toEqual(testCase.expected)
      expect(recordedEffects()).toEqual(testCase.effects)
    })
  }
})

describe('createResponsesTerminalObservers', () => {
  const terminalCases: Array<{ name: string, response: ResponsesResult, error: string | undefined }> = [
    {
      name: 'records a failed terminal response',
      response: buildResponsesResult({ status: 'failed' }),
      error: 'Upstream HTTP 200 (response_failed)',
    },
    {
      name: 'records a terminal response carrying an error',
      response: buildResponsesResult({ status: 'completed', error: { code: 'server_error', message: 'boom' } }),
      error: 'Upstream HTTP 200 (response_failed)',
    },
    {
      name: 'records nothing for a completed terminal response',
      response: buildResponsesResult({ status: 'completed' }),
      error: undefined,
    },
  ]

  for (const testCase of terminalCases) {
    test(testCase.name, () => {
      createResponsesTerminalObservers(REQUEST_ID, {}).onTerminalResponse(testCase.response)
      expect(recordedError()).toBe(testCase.error)
    })
  }

  test('records a stream that ends without a terminal event', () => {
    createResponsesTerminalObservers(REQUEST_ID, { clientSignal: new AbortController().signal })
      .onStreamEndWithoutTerminal()
    expect(recordedError()).toBe('Upstream HTTP 200 (response_stream_eof)')
  })

  test('does not record a stream cut short by the client aborting', () => {
    const client = new AbortController()
    const observers = createResponsesTerminalObservers(REQUEST_ID, { clientSignal: client.signal })
    client.abort()
    observers.onStreamEndWithoutTerminal()
    expect(recordedError()).toBeUndefined()
  })
})
