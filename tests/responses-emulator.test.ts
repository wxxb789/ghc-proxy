import type { CapturedResponsesCall } from './helpers'
import type { ResponsesResult, ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { TerminalUpstreamRecoveryError } from '~/clients/upstream-queue'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { authStore, modelCache, responsesEmulatorState } from '~/state'
import { createResponsesEmulatorState } from '~/state/responses-emulator-state'

import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
  createApp,
  mockEmulatorCreateResponses,
  parseSse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

type GetResponse = typeof CopilotClient.prototype.getResponse
type GetResponseInputItems = typeof CopilotClient.prototype.getResponseInputItems
type CreateResponseInputTokens = typeof CopilotClient.prototype.createResponseInputTokens
type DeleteResponse = typeof CopilotClient.prototype.deleteResponse

// ── Emulator-policy helpers (only this file needs them) ──

function enableOfficialResponsesEmulator(ttlSeconds = 4 * 60 * 60) {
  const config = getCachedConfig() as Record<string, unknown>
  config.responsesOfficialEmulator = true
  config.responsesOfficialEmulatorTtlSeconds = ttlSeconds
}

function rejectUnexpectedEmulatorResourceCalls() {
  const reject = (method: string) => {
    throw new Error(`Unexpected upstream ${method} call while responsesOfficialEmulator is enabled`)
  }

  CopilotClient.prototype.getResponse = ((..._args: Array<unknown>) => reject('getResponse')) as GetResponse
  CopilotClient.prototype.getResponseInputItems = ((..._args: Array<unknown>) => reject('getResponseInputItems')) as GetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = ((..._args: Array<unknown>) => reject('createResponseInputTokens')) as CreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = ((..._args: Array<unknown>) => reject('deleteResponse')) as DeleteResponse
}

const originalCreateResponses = CopilotClient.prototype.createResponses
const originalCreateMessages = CopilotClient.prototype.createMessages
const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions
const originalGetResponse = CopilotClient.prototype.getResponse
const originalGetResponseInputItems = CopilotClient.prototype.getResponseInputItems
const originalCreateResponseInputTokens = CopilotClient.prototype.createResponseInputTokens
const originalDeleteResponse = CopilotClient.prototype.deleteResponse
const stateSnapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())

beforeEach(() => {
  setupDefaultTestState()
  authStore.showToken = false
  authStore.upstreamTimeoutSeconds = undefined

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  CopilotClient.prototype.createResponses = originalCreateResponses
  CopilotClient.prototype.createMessages = originalCreateMessages
  CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
  CopilotClient.prototype.getResponse = originalGetResponse
  CopilotClient.prototype.getResponseInputItems = originalGetResponseInputItems
  CopilotClient.prototype.createResponseInputTokens = originalCreateResponseInputTokens
  CopilotClient.prototype.deleteResponse = originalDeleteResponse
  restoreStateSnapshot(stateSnapshot)
  setSystemTime()

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
  Object.assign(config, structuredClone(originalConfig))
})

describe('responses official emulator', () => {
  test('/v1/responses official emulator persists create, retrieve, and input_items state', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_emu_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'world', annotations: [] }],
        }],
        output_text: 'world',
        usage: null,
      }),
    ], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    const created = await createResponse.json() as ResponsesResult
    expect(createResponse.status).toBe(200)
    expect(created).toMatchObject({
      id: 'resp_emu_1',
      object: 'response',
      model: 'gpt-5',
      previous_response_id: null,
      store: true,
    })
    expect(created.conversation).toBeTruthy()
    expect(createCalls[0]?.payload.input).toEqual([{
      type: 'message',
      role: 'user',
      content: 'hello',
    }])
    expect(createCalls[0]?.payload.previous_response_id).toBeUndefined()
    expect(createCalls[0]?.payload.conversation).toBeUndefined()

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_1', {
      method: 'GET',
    }))

    const retrieved = await retrieveResponse.json() as ResponsesResult
    expect(retrieveResponse.status).toBe(200)
    expect(retrieved.id).toBe('resp_emu_1')
    expect(retrieved.conversation).toEqual(created.conversation)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_1/input_items?limit=10&order=asc', {
      method: 'GET',
    }))

    const inputItems = await inputItemsResponse.json() as {
      object?: string
      data?: Array<{ type?: string, role?: string, content?: string }>
      first_id?: string | null
      last_id?: string | null
      has_more?: boolean
    }
    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems).toEqual({
      object: 'list',
      data: [{
        type: 'message',
        role: 'user',
        content: 'hello',
      }],
      first_id: null,
      last_id: null,
      has_more: false,
    })
  })

  test('/v1/responses official emulator persists filtered input items sent upstream', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    const expectedInput = [
      { type: 'message', role: 'user', content: 'hello' },
    ]
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_filtered',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'ok',
        usage: null,
      }),
    ], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [
          { type: 'item_reference', id: 'item_unresolvable' },
          { type: 'message', role: 'user', content: 'hello' },
        ],
      }),
    }))

    expect(createResponse.status).toBe(200)
    expect(createCalls[0]?.payload.input).toEqual(expectedInput)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_filtered/input_items', {
      method: 'GET',
    }))
    const inputItems = await inputItemsResponse.json() as { data?: Array<unknown> }

    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems.data).toEqual(expectedInput)
  })

  test('/v1/responses official emulator persists compacted input items from streamed requests', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    getCachedConfig().responsesApiAutoCompactInput = true
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    const expectedInput = [
      { type: 'compaction', id: 'cmp_latest', encrypted_content: 'enc_latest' },
      { type: 'message', role: 'user', content: 'after' },
    ]
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([(
      async function* () {
        yield {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            sequence_number: 1,
            response: buildResponsesResult({
              id: 'resp_emu_compacted',
              model: 'gpt-5',
              status: 'completed',
              output_text: 'ok',
              usage: null,
            }),
          } satisfies ResponseStreamEvent),
        }
      }
    )()], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [
          { type: 'message', role: 'user', content: 'before' },
          { type: 'compaction', id: 'cmp_latest', encrypted_content: 'enc_latest' },
          { type: 'message', role: 'user', content: 'after' },
        ],
      }),
    }))

    await createResponse.text()
    expect(createResponse.status).toBe(200)
    expect(createCalls[0]?.payload.input).toEqual(expectedInput)

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_compacted/input_items', {
      method: 'GET',
    }))
    const inputItems = await inputItemsResponse.json() as { data?: Array<unknown> }

    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems.data).toEqual(expectedInput)
  })

  test('/v1/responses official emulator persists the successful overload fallback attempt input', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    const config = getCachedConfig()
    config.overloadFallbacks = { source: 'target' }
    config.responsesApiParameterFilters = [{ models: ['target'], params: ['input'] }]
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source', { supported_endpoints: ['/responses'] }),
      buildModel('target', { supported_endpoints: ['/responses'] }),
    ))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = (async (payload, options) => {
      createCalls.push({ payload, options })
      if (createCalls.length === 1) {
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }),
          { requestId: 'responses-emulator-fallback', retryCount: 1, sourceModel: 'source' },
        )
      }
      return buildResponsesResult({
        id: 'resp_emu_fallback',
        model: 'target',
        status: 'completed',
        output_text: 'ok',
        usage: null,
      })
    }) as typeof CopilotClient.prototype.createResponses

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'source',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(createResponse.status).toBe(200)
    expect(createCalls).toHaveLength(2)
    expect(createCalls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])
    expect(createCalls[1]?.payload.input).toBeUndefined()

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_fallback/input_items', {
      method: 'GET',
    }))
    const inputItems = await inputItemsResponse.json() as { data?: Array<unknown> }

    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems.data).toEqual([])
  })

  test('/v1/responses official emulator returns decorated create results even when store=false', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_nostore',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'ok',
        usage: null,
      }),
    ], [])

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        store: false,
        input: [{ type: 'message', role: 'user', content: 'ephemeral' }],
      }),
    }))

    const created = await createResponse.json() as ResponsesResult
    expect(createResponse.status).toBe(200)
    expect(created).toMatchObject({
      id: 'resp_emu_nostore',
      previous_response_id: null,
      store: false,
    })
    expect(created.conversation).toBeTruthy()

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_nostore', {
      method: 'GET',
    }))
    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_nostore/input_items', {
      method: 'GET',
    }))
    expect(retrieveResponse.status).toBe(404)
    expect(inputItemsResponse.status).toBe(404)
  })

  // Regression guard for Plan A (symmetric translateResult): the non-stream
  // emulator decorate+persist now lives entirely in the passthrough strategy's
  // translateResult seam, not a handler post-pipeline block. Pin the two
  // properties the existing 200/404 tests above do NOT assert:
  //   1. persist fires EXACTLY once (single-persist) on the JSON path, and
  //   2. the decorated `store` is sourced from the ORIGINAL request (captured at
  //      afterIngest as prepared.shouldStore), NOT the upstream payload whose
  //      `store` afterTransform forces to false — proving the emulator state
  //      survives the post-ingest payload mutation.
  test('/v1/responses official emulator decorates from the original payload and persists exactly once (non-stream)', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_once',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'pinned',
        usage: null,
      }),
    ], createCalls)

    const setResponseSpy = responsesEmulatorState.setResponse.bind(responsesEmulatorState)
    let setResponseCount = 0
    responsesEmulatorState.setResponse = ((response: ResponsesResult) => {
      setResponseCount++
      return setResponseSpy(response)
    }) as typeof responsesEmulatorState.setResponse

    try {
      const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5',
          // Client omits `store` (defaults to true). afterTransform forces the
          // upstream payload's store to false; the decorated output must still be
          // true because it reads prepared.shouldStore captured from this original
          // request — the discriminator between original vs mutated payload.
          input: [{ type: 'message', role: 'user', content: 'hello' }],
        }),
      }))

      const created = await createResponse.json() as ResponsesResult
      expect(createResponse.status).toBe(200)
      expect(created).toMatchObject({
        id: 'resp_emu_once',
        previous_response_id: null,
        store: true,
      })
      expect(created.conversation).toBeTruthy()
      // The upstream call received store:false (afterTransform forces it), yet the
      // decorated output is store:true — proving the emulator reads the original
      // request's shouldStore, not the mutated upstream payload.
      expect(createCalls[0]?.payload.store).toBe(false)
      // Single-persist: the strategy seam persisted the JSON response once only.
      expect(setResponseCount).toBe(1)

      // And it is genuinely retrievable (persist actually ran).
      const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_once', {
        method: 'GET',
      }))
      expect(retrieveResponse.status).toBe(200)
      // GET retrieve does not re-persist.
      expect(setResponseCount).toBe(1)
    }
    finally {
      responsesEmulatorState.setResponse = setResponseSpy
    }
  })

  test('/v1/responses official emulator persists streamed terminal responses for later retrieval', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([(
      async function* () {
        yield {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            sequence_number: 1,
            response: buildResponsesResult({
              id: 'resp_stream_1',
              model: 'gpt-5',
              status: 'in_progress',
              output_text: '',
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                total_tokens: 1,
              },
            }),
          } satisfies ResponseStreamEvent),
        }
        yield {
          event: 'response.completed',
          data: JSON.stringify({
            type: 'response.completed',
            sequence_number: 2,
            response: buildResponsesResult({
              id: 'resp_stream_1',
              model: 'gpt-5',
              status: 'completed',
              output: [{
                id: 'msg_stream_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'streamed', annotations: [] }],
              }],
              output_text: 'streamed',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
              },
            }),
          } satisfies ResponseStreamEvent),
        }
      }
    )()], createCalls)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    const body = await createResponse.text()
    expect(createResponse.status).toBe(200)
    const events = parseSse(body)
    const createdEvent = events.find(event => event.event === 'response.created')
    const completedEvent = events.find(event => event.event === 'response.completed')
    const createdPayload = createdEvent?.data ? JSON.parse(createdEvent.data) as ResponseStreamEvent : undefined
    const completedPayload = completedEvent?.data ? JSON.parse(completedEvent.data) as ResponseStreamEvent : undefined
    expect(createdPayload?.type).toBe('response.created')
    expect(completedPayload?.type).toBe('response.completed')
    expect((createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation).toBeTruthy()
    expect((createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation).toEqual(
      (completedPayload as Extract<ResponseStreamEvent, { type: 'response.completed' }>)?.response.conversation,
    )
    expect((completedPayload as Extract<ResponseStreamEvent, { type: 'response.completed' }>)?.response.store).toBe(true)

    const retrieveResponse = await app.handle(new Request('http://localhost/v1/responses/resp_stream_1', {
      method: 'GET',
    }))
    const retrieved = await retrieveResponse.json() as ResponsesResult

    expect(retrieveResponse.status).toBe(200)
    expect(retrieved.id).toBe('resp_stream_1')
    expect(retrieved.output_text).toBe('streamed')
    expect(retrieved.status).toBe('completed')
    expect(retrieved.conversation).toEqual(
      (createdPayload as Extract<ResponseStreamEvent, { type: 'response.created' }>)?.response.conversation,
    )
    expect(createCalls).toHaveLength(1)
  })

  test('/v1/responses official emulator allows continuing from the conversation emitted in streamed created events', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      (
        async function* () {
          yield {
            event: 'response.created',
            data: JSON.stringify({
              type: 'response.created',
              sequence_number: 0,
              response: buildResponsesResult({
                id: 'resp_stream_continue_1',
                model: 'gpt-5',
                status: 'in_progress',
                usage: null,
              }),
            } satisfies ResponseStreamEvent),
          }
          yield {
            event: 'response.completed',
            data: JSON.stringify({
              type: 'response.completed',
              sequence_number: 1,
              response: buildResponsesResult({
                id: 'resp_stream_continue_1',
                model: 'gpt-5',
                status: 'completed',
                output: [{
                  id: 'msg_stream_continue_1',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'streamed first', annotations: [] }],
                }],
                output_text: 'streamed first',
                usage: null,
              }),
            } satisfies ResponseStreamEvent),
          }
        }
      )(),
      buildResponsesResult({
        id: 'resp_stream_continue_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'streamed second',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const firstEvents = parseSse(await firstResponse.text())
    const createdEvent = firstEvents.find(event => event.event === 'response.created')
    const createdPayload = createdEvent?.data ? JSON.parse(createdEvent.data) as Extract<ResponseStreamEvent, { type: 'response.created' }> : undefined

    expect(createdPayload?.response.conversation).toBeTruthy()

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        conversation: createdPayload?.response.conversation,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))
    const second = await secondResponse.json() as ResponsesResult

    expect(secondResponse.status).toBe(200)
    expect(second.conversation).toEqual(createdPayload?.response.conversation)
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'streamed first' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses official emulator continues from previous_response_id', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_prev_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello back', annotations: [] }],
        }],
        output_text: 'hello back',
        usage: null,
      }),
      buildResponsesResult({
        id: 'resp_emu_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'done',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: first.id,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    const second = await secondResponse.json() as ResponsesResult
    expect(secondResponse.status).toBe(200)
    expect(second.previous_response_id).toBe(first.id)
    expect(second.id).toBe('resp_emu_2')
    expect(second.conversation).toEqual(first.conversation)
    expect(createCalls[1]?.payload.previous_response_id).toBeUndefined()
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello back' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])

    const inputItemsResponse = await app.handle(new Request('http://localhost/v1/responses/resp_emu_2/input_items?order=asc', {
      method: 'GET',
    }))
    const inputItems = await inputItemsResponse.json() as {
      data?: Array<unknown>
    }

    expect(inputItemsResponse.status).toBe(200)
    expect(inputItems.data).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello back' }],
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ])
  })

  test('/v1/responses official emulator continues from conversation head when conversation is provided', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_conv_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_conv_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'first reply', annotations: [] }],
        }],
        output_text: 'first reply',
        usage: null,
      }),
      buildResponsesResult({
        id: 'resp_conv_2',
        model: 'gpt-5',
        status: 'completed',
        output_text: 'second reply',
        usage: null,
      }),
    ], createCalls)

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'turn one' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const secondResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        conversation: first.conversation,
        input: [{ type: 'message', role: 'user', content: 'turn two' }],
      }),
    }))
    const second = await secondResponse.json() as ResponsesResult

    expect(secondResponse.status).toBe(200)
    expect(second.previous_response_id).toBeNull()
    expect(second.conversation).toEqual(first.conversation)
    expect(createCalls[1]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'turn one' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first reply' }],
      },
      { type: 'message', role: 'user', content: 'turn two' },
    ])
  })

  test('/v1/responses official emulator rejects unknown previous_response_id before any upstream call', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    const createCalls: Array<CapturedResponsesCall> = []
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([], createCalls)

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: 'resp_missing',
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    expect(response.status).toBe(400)
    expect(createCalls).toHaveLength(0)
  })

  test('/v1/responses official emulator delete semantics remove stored state', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        usage: null,
      }),
    ], [])

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const created = await createResponse.json() as ResponsesResult

    const deleteResponse = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'DELETE',
    }))
    const deleted = await deleteResponse.json() as {
      id?: string
      object?: string
      deleted?: boolean
    }

    expect(deleteResponse.status).toBe(200)
    expect(deleted).toEqual({
      id: created.id,
      object: 'response.deleted',
      deleted: true,
    })

    const retrieveAfterDelete = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    const inputItemsAfterDelete = await app.handle(new Request(`http://localhost/v1/responses/${created.id}/input_items`, {
      method: 'GET',
    }))
    expect(retrieveAfterDelete.status).toBe(404)
    expect(inputItemsAfterDelete.status).toBe(404)
  })

  test('/v1/responses official emulator expires responses after the configured 4h TTL', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator(4 * 60 * 60)
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        usage: null,
      }),
    ], [])

    const baseTime = new Date('2026-04-02T00:00:00.000Z')
    setSystemTime(baseTime)

    const createResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const created = await createResponse.json() as ResponsesResult

    const deleteBeforeTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    expect(deleteBeforeTtl.status).toBe(200)

    setSystemTime(new Date(baseTime.getTime() + (4 * 60 * 60 * 1000) + 1))

    const retrieveAfterTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}`, {
      method: 'GET',
    }))
    const inputItemsAfterTtl = await app.handle(new Request(`http://localhost/v1/responses/${created.id}/input_items`, {
      method: 'GET',
    }))

    expect(retrieveAfterTtl.status).toBe(404)
    expect(inputItemsAfterTtl.status).toBe(404)
  })

  test('/v1/responses official emulator rejects background mode explicitly', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        background: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(400)
  })

  test('/v1/responses official emulator paginates input_items after sorting for descending queries', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))

    responsesEmulatorState.setResponse(buildResponsesResult({
      id: 'resp_desc_page',
      model: 'gpt-5',
      conversation: { id: 'conv_desc_page' },
    }))
    responsesEmulatorState.setInputItems('resp_desc_page', [
      { id: 'item_1', type: 'compaction', encrypted_content: 'enc_1' },
      { id: 'item_2', type: 'compaction', encrypted_content: 'enc_2' },
      { id: 'item_3', type: 'compaction', encrypted_content: 'enc_3' },
      { id: 'item_4', type: 'compaction', encrypted_content: 'enc_4' },
    ])

    const response = await app.handle(new Request('http://localhost/v1/responses/resp_desc_page/input_items?order=desc&after=item_3&limit=2', {
      method: 'GET',
    }))
    const payload = await response.json() as {
      data: Array<{ id: string }>
      first_id: string | null
      last_id: string | null
      has_more: boolean
    }

    expect(response.status).toBe(200)
    expect(payload.data.map(item => item.id)).toEqual(['item_2', 'item_1'])
    expect(payload.first_id).toBe('item_2')
    expect(payload.last_id).toBe('item_1')
    expect(payload.has_more).toBe(false)
  })

  test('/v1/responses/input_tokens official emulator estimates tokens from continued history', async () => {
    const app = createApp()
    enableOfficialResponsesEmulator()
    rejectUnexpectedEmulatorResourceCalls()
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5', { supported_endpoints: ['/responses'] })))
    CopilotClient.prototype.createResponses = mockEmulatorCreateResponses([
      buildResponsesResult({
        id: 'resp_emu_1',
        model: 'gpt-5',
        status: 'completed',
        output: [{
          id: 'msg_token_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'assistant context', annotations: [] }],
        }],
        output_text: 'assistant context',
        usage: null,
      }),
    ], [])

    const firstResponse = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))
    const first = await firstResponse.json() as ResponsesResult

    const tokenResponse = await app.handle(new Request('http://localhost/v1/responses/input_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        previous_response_id: first.id,
        input: [{ type: 'message', role: 'user', content: 'follow up' }],
      }),
    }))

    const tokens = await tokenResponse.json() as {
      object?: string
      input_tokens?: number
    }
    expect(tokenResponse.status).toBe(200)
    expect(tokens.object).toBe('response.input_tokens')
    expect(typeof tokens.input_tokens).toBe('number')
    expect(tokens.input_tokens).toBeGreaterThan(0)
  })
})

describe('responses emulator state', () => {
  test('clones stored responses and input items on read and write', () => {
    const state = createResponsesEmulatorState()
    const response = buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    })

    state.setResponse(response)
    state.setInputItems('resp_1', [
      { type: 'message', role: 'user', content: 'hello' },
    ])

    const storedResponse = state.getResponse('resp_1')
    const storedInputItems = state.getInputItems('resp_1')

    expect(storedResponse).toMatchObject({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    })
    expect(storedInputItems).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])

    if (storedResponse) {
      storedResponse.output_text = 'mutated'
    }
    if (storedInputItems) {
      storedInputItems[0] = { type: 'message', role: 'user', content: 'changed' }
    }

    expect(state.getResponse('resp_1')?.output_text).toBe('')
    expect(state.getInputItems('resp_1')).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])
  })

  test('tracks conversation heads and clears them when the head response is deleted', () => {
    const state = createResponsesEmulatorState()

    state.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }))
    state.setResponse(buildResponsesResult({
      id: 'resp_2',
      conversation: { id: 'conv_1' },
    }))

    expect(state.getConversation('conv_1')).toEqual({ id: 'conv_1' })
    expect(state.getConversationHead('conv_1')).toBe('resp_2')

    state.deleteResponse('resp_2')

    expect(state.getConversationHead('conv_1')).toBeUndefined()
    expect(state.getConversation('conv_1')).toEqual({ id: 'conv_1' })
  })

  test('expires deletion flags and stored entries after ttl elapses', () => {
    const state = createResponsesEmulatorState()
    const baseTime = new Date('2026-04-02T00:00:00.000Z')
    setSystemTime(baseTime)

    state.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }), { ttlSeconds: 1 })
    state.setInputItems('resp_1', [
      { type: 'message', role: 'user', content: 'hello' },
    ], { ttlSeconds: 1 })

    state.deleteResponse('resp_1', { ttlSeconds: 1 })

    expect(state.getResponse('resp_1')).toBeUndefined()
    expect(state.getInputItems('resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('response', 'resp_1')).toBeDefined()
    expect(state.getDeletionFlag('input_items', 'resp_1')).toBeDefined()

    setSystemTime(new Date(baseTime.getTime() + 1500))
    state.pruneExpired()

    expect(state.getResponse('resp_1')).toBeUndefined()
    expect(state.getInputItems('resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('response', 'resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('input_items', 'resp_1')).toBeUndefined()
    expect(state.snapshot()).toEqual({
      responses: 0,
      conversations: 0,
      conversationHeads: 0,
      inputItems: 0,
      deletions: 0,
    })
  })

  test('enforces memory cap across multi-entry setResponse writes', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 10 })

    for (let i = 0; i < 20; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    expect(state.totalEntries()).toBeLessThanOrEqual(10)
  })

  test('enforces memory cap when deletion flags are added', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 10 })

    for (let i = 0; i < 5; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    for (let i = 0; i < 20; i++) {
      state.deleteResponse(`resp_del_${i}`)
    }

    expect(state.totalEntries()).toBeLessThanOrEqual(10)
  })

  test('skips cap enforcement for key updates that do not grow entry count', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 6 })

    for (let i = 0; i < 2; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    const beforeUpdate = state.totalEntries()

    state.setResponse(buildResponsesResult({
      id: 'resp_0',
      conversation: { id: 'conv_0' },
    }))

    expect(state.totalEntries()).toBe(beforeUpdate)
  })

  test('keeps separate instances isolated and clearable', () => {
    const first = createResponsesEmulatorState()
    const second = createResponsesEmulatorState()

    first.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }))
    second.setResponse(buildResponsesResult({
      id: 'resp_2',
      conversation: { id: 'conv_2' },
    }))

    expect(first.getResponse('resp_2')).toBeUndefined()
    expect(second.getResponse('resp_1')).toBeUndefined()
    expect(first.snapshot().responses).toBe(1)
    expect(second.snapshot().responses).toBe(1)

    first.clear()
    expect(first.snapshot()).toEqual({
      responses: 0,
      conversations: 0,
      conversationHeads: 0,
      inputItems: 0,
      deletions: 0,
    })
  })
})
