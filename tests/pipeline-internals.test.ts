import type { StateSnapshot } from './helpers'
import type { StrategyEntry } from '~/dispatch'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { RecoveryEvent } from '~/lib/request-logger'
import type { IngestContext, PipelineConfig, TransformContext } from '~/pipeline/runner'

import type { ChatCompletionsPayload, Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import consola from 'consola'
import {
  FallbackCooldownError,
  LocalModelCooldownError,
  TerminalUpstreamRecoveryError,
  UpstreamRequestQueue,
} from '~/clients/upstream-queue'
import { StrategyRegistry } from '~/dispatch'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import { runPipeline } from '~/pipeline/runner'
import { authStore, modelCache } from '~/state'

import {
  buildModel,
  buildModelsResponse,
  clearConfig,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

// ── StrategyRegistry — selection priority + messages registry wiring ──

describe('StrategyRegistry', () => {
  function makeEntry<TCtx = unknown>(
    name: string,
    canHandle: (model: Model | undefined) => boolean,
  ): StrategyEntry<TCtx> {
    return {
      name,
      canHandle,
      execute: () => Promise.resolve({ kind: 'json', data: {} } as ExecutionResult),
    }
  }

  test('throws on empty registry', () => {
    const registry = new StrategyRegistry()
    expect(() => registry.select(undefined)).toThrow('StrategyRegistry has no registered entries')
  })

  test('single entry with canHandle returning true', () => {
    const registry = new StrategyRegistry()
    const entry = makeEntry('only', () => true)
    registry.register(entry)
    expect(registry.select(undefined)).toBe(entry)
  })

  test('multi-entry priority — selects first matching', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => true)
    const third = makeEntry('third', () => true)
    registry.register(first)
    registry.register(second)
    registry.register(third)

    expect(registry.select(undefined)).toBe(second)
  })

  test('falls back to last entry when none match', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => false)
    registry.register(first)
    registry.register(second)

    expect(registry.select(undefined)).toBe(second)
  })

  test('canHandle receives model parameter correctly', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    const testModel = buildModel('test-model-123')
    registry.select(testModel)

    expect(receivedModel).toBe(testModel)
  })

  test('canHandle receives undefined when no model', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined = buildModel('placeholder')

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    registry.select(undefined)
    expect(receivedModel).toBeUndefined()
  })
})

describe('messages defaultStrategyRegistry', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
  })

  test('selects native-messages for model with /v1/messages endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const nativeModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages'],
    })
    modelCache.cacheModels(buildModelsResponse(nativeModel))

    const selected = defaultStrategyRegistry.select(nativeModel)
    expect(selected.name).toBe('native-messages')
  })

  test('selects responses-api for model with /responses endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const responsesModel = buildModel('claude-sonnet-4.5', {
      supported_endpoints: ['/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(responsesModel))

    const selected = defaultStrategyRegistry.select(responsesModel)
    expect(selected.name).toBe('responses-api')
  })

  test('selects chat-completions as fallback for model with no supported endpoints', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const basicModel = buildModel('gpt-5.4')
    modelCache.cacheModels(buildModelsResponse(basicModel))

    const selected = defaultStrategyRegistry.select(basicModel)
    expect(selected.name).toBe('chat-completions')
  })

  test('selects chat-completions when model is undefined', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const selected = defaultStrategyRegistry.select(undefined)
    expect(selected.name).toBe('chat-completions')
  })

  test('native-messages takes priority over responses-api when both endpoints supported', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const dualModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages', '/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(dualModel))

    const selected = defaultStrategyRegistry.select(dualModel)
    expect(selected.name).toBe('native-messages')
  })
})

// ── runPipeline — ingest → transform → dispatch orchestration ──

describe('runPipeline', () => {
  const originalState = saveStateSnapshot()

  beforeEach(() => {
    setupDefaultTestState()
    clearConfig()
  })

  afterEach(() => {
    restoreStateSnapshot(originalState)
    clearConfig()
  })

  interface SimplePayload {
    model: string
    messages: Array<{ role: string, content: string }>
  }

  function makeStrategyRegistry(
    result: ExecutionResult = { kind: 'json', data: { ok: true } },
  ): StrategyRegistry<{ payload: SimplePayload }> {
    const registry = new StrategyRegistry<{ payload: SimplePayload }>()
    registry.register({
      name: 'test-strategy',
      canHandle: () => true,
      execute: async () => result,
    })
    return registry
  }

  function makeParams(body: SimplePayload): {
    body: SimplePayload
    signal: AbortSignal
    headers: Headers
    requestId: string
    callerRequestId?: string
  } {
    return {
      body,
      signal: new AbortController().signal,
      headers: new Headers({ 'content-type': 'application/json' }),
      requestId: 'internal-request-id',
    }
  }

  function makeConfig(
    overrides: Partial<PipelineConfig<SimplePayload, { payload: SimplePayload }>> = {},
  ): PipelineConfig<SimplePayload, { payload: SimplePayload }> {
    return {
      protocol: 'openai-chat',
      strategyRegistry: makeStrategyRegistry(),
      buildStrategyContext: ({ payload }) => ({ payload }),
      ...overrides,
    }
  }

  test('basic pipeline flow returns json result', async () => {
    const expectedData = { response: 'hello' }
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'json-strategy',
      canHandle: () => true,
      execute: async () => ({ kind: 'json' as const, data: expectedData }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig({
      strategyRegistry,
    })

    const { result, modelMapping } = await runPipeline(params, config)

    expect(result.kind).toBe('json')
    expect((result as { kind: 'json', data: unknown }).data).toEqual(expectedData)
    expect(modelMapping.originalModel).toBe('claude-sonnet-4.5')
  })

  test('model rewrite is reflected in model mapping trace', async () => {
    // Drives the real rewrite via config rather than a stand-in chain, so the
    // trace assertion covers the production resolveRequestModel wiring.
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.modelRewrites = [{ from: 'old-model', to: 'new-model' }]
    modelCache.cacheModels(buildModelsResponse(buildModel('new-model')))

    const params = makeParams({ model: 'old-model', messages: [{ role: 'user', content: 'hi' }] })

    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const config = makeConfig({
      strategyRegistry,
    })

    const { modelMapping } = await runPipeline(params, config)

    expect(modelMapping.originalModel).toBe('old-model')
    expect(modelMapping.steps).toHaveLength(1)
    expect(modelMapping.steps[0]).toEqual({ tag: 'CONFIG_REWRITE', from: 'old-model', to: 'new-model' })
    // The strategy should receive the rewritten model in the payload
    expect(executedPayloads[0]?.model).toBe('new-model')
  })

  test('afterIngest hook is called with ingest result', async () => {
    const captured: IngestContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config = makeConfig({
      afterIngest: (ctx) => {
        captured.push(ctx)
        return ctx.payload
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.payload.model).toBe('claude-sonnet-4.5')
    expect(captured[0]!.payload.messages[0]?.content).toBe('test')
    expect(captured[0]!.headers).toBeInstanceOf(Headers)
  })

  test('afterIngest returned payload replaces the payload for transform + dispatch', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const replacement: SimplePayload = {
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'REPLACED' }],
    }
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      // Mirrors /responses returning the emulator's upstream payload.
      afterIngest: () => replacement,
    })

    await runPipeline(params, config)

    // The replacement payload — not the ingested one — reaches the strategy.
    expect(executedPayloads[0]?.messages[0]?.content).toBe('REPLACED')
  })

  test('afterIngest returning ctx.payload keeps the ingested payload (no-substitution case)', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      // Side-effect-only callers (messages, chat-completions) end with this.
      afterIngest: ({ payload }) => payload,
    })

    await runPipeline(params, config)

    expect(executedPayloads[0]?.messages[0]?.content).toBe('original')
  })

  test('keeps the source payload in place when overload fallback is disabled', async () => {
    let ingestedPayload: SimplePayload | undefined
    let executedPayload: SimplePayload | undefined
    const registry = new StrategyRegistry<{ payload: SimplePayload }>()
    registry.register({
      name: 'identity-test',
      canHandle: () => true,
      execute: async ({ payload }) => {
        executedPayload = payload
        return { kind: 'json', data: { ok: true } }
      },
    })

    await runPipeline(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'large' }] }),
      makeConfig({
        strategyRegistry: registry,
        afterIngest({ payload }) {
          ingestedPayload = payload
          return payload
        },
      }),
    )

    expect(executedPayload).toBe(ingestedPayload)
  })

  test('does not clone for an unrelated mapping on advertised Messages or Responses models', async () => {
    interface MessagesPayload {
      model: string
      max_tokens: number
      messages: Array<{ role: 'user', content: string }>
    }
    const originalStructuredClone = globalThis.structuredClone
    let cloneCalls = 0
    globalThis.structuredClone = ((value: unknown) => {
      cloneCalls++
      return originalStructuredClone(value)
    }) as typeof globalThis.structuredClone

    try {
      for (const endpoint of ['/v1/messages', '/responses'] as const) {
        cloneCalls = 0
        const sourceId = `source-${endpoint}`
        modelCache.cacheModels(buildModelsResponse(
          buildModel(sourceId, { supported_endpoints: [endpoint] }),
          buildModel('unrelated'),
          buildModel('target'),
        ))
        const config_ = getCachedConfig() as Record<string, unknown>
        config_.overloadFallbacks = { unrelated: 'target' }

        let ingestedPayload: MessagesPayload | undefined
        let executedPayload: MessagesPayload | undefined
        const registry = new StrategyRegistry<{
          payload: MessagesPayload
          cleanup: () => void
        }>()
        registry.register({
          name: 'clone-count',
          canHandle: () => true,
          execute: async ({ payload, cleanup }) => {
            executedPayload = payload
            cleanup()
            return { kind: 'json', data: { ok: true } }
          },
        })
        const body: MessagesPayload = {
          model: sourceId,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }],
        }

        await runPipeline<MessagesPayload, {
          payload: MessagesPayload
          cleanup: () => void
        }>(
          {
            body,
            signal: new AbortController().signal,
            headers: new Headers({ 'content-type': 'application/json' }),
            requestId: `unrelated-${endpoint}`,
          },
          {
            protocol: 'anthropic-messages',
            strategyRegistry: registry,
            afterIngest({ payload }) {
              ingestedPayload = payload
              return payload
            },
            buildStrategyContext: ({ payload, upstreamSignal }) => ({
              payload,
              cleanup: upstreamSignal.cleanup,
            }),
          },
        )

        expect(cloneCalls).toBe(0)
        expect(executedPayload).toBe(ingestedPayload)
      }
    }
    finally {
      globalThis.structuredClone = originalStructuredClone
    }
  })

  test('afterTransform hook observes the resolved model', async () => {
    const captured: TransformContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config_ = getCachedConfig() as Record<string, unknown>
    config_.modelRewrites = [{ from: 'claude-sonnet-4.5', to: 'claude-opus-4.6' }]
    modelCache.cacheModels(buildModelsResponse(buildModel('claude-opus-4.6')))

    const config = makeConfig({
      afterTransform: (ctx) => {
        captured.push(ctx)
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    // The hook runs after model resolution, so it sees the rewritten model
    // on both the payload and the resolved model record.
    expect(captured[0]!.payload.model).toBe('claude-opus-4.6')
    expect(captured[0]!.selectedModel?.id).toBe('claude-opus-4.6')
  })

  test('afterTransform hook can mutate payload', async () => {
    const executedPayloads: SimplePayload[] = []
    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'capture-strategy',
      canHandle: () => true,
      execute: async (ctx) => {
        executedPayloads.push(ctx.payload)
        return { kind: 'json', data: { ok: true } }
      },
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'original' }] })
    const config = makeConfig({
      strategyRegistry,
      afterTransform: (ctx) => {
        ctx.payload.messages = [{ role: 'user', content: 'mutated' }]
      },
    })

    await runPipeline(params, config)

    expect(executedPayloads[0]!.messages[0]?.content).toBe('mutated')
  })

  test('model mapping shows original model when no transforms apply', async () => {
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig()

    const { modelMapping } = await runPipeline(params, config)

    expect(modelMapping.originalModel).toBe('claude-sonnet-4.5')
    expect(modelMapping.steps).toHaveLength(0)
  })

  test('stream result kind is propagated', async () => {
    async function* fakeSSE() {
      yield { data: '{"event":"done"}' }
    }

    const strategyRegistry = new StrategyRegistry<{ payload: SimplePayload }>()
    strategyRegistry.register({
      name: 'stream-strategy',
      canHandle: () => true,
      execute: async (): Promise<ExecutionResult> => ({
        kind: 'stream',
        generator: fakeSSE(),
      }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config = makeConfig({ strategyRegistry })

    const { result } = await runPipeline(params, config)

    expect(result.kind).toBe('stream')
  })

  test('buildStrategyContext receives all expected fields', async () => {
    let capturedCtx: Record<string, unknown> | undefined
    const strategyRegistry = new StrategyRegistry<Record<string, unknown>>()
    strategyRegistry.register({
      name: 'spy-strategy',
      canHandle: () => true,
      execute: async () => ({ kind: 'json' as const, data: {} }),
    })

    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] })
    const config: PipelineConfig<SimplePayload, Record<string, unknown>> = {
      protocol: 'openai-chat',
      strategyRegistry,
      buildStrategyContext: (ctx) => {
        capturedCtx = ctx as Record<string, unknown>
        return ctx
      },
    }

    await runPipeline(params, config)

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.payload).toBeDefined()
    expect(capturedCtx!.meta).toBeDefined()
    expect(capturedCtx!.headers).toBeInstanceOf(Headers)
    expect(capturedCtx!.copilotClient).toBeDefined()
    expect(capturedCtx!.upstreamSignal).toBeDefined()
    expect(capturedCtx!.modelMapping).toBeDefined()
    expect(capturedCtx!.recovery).toEqual({
      requestId: 'internal-request-id',
      callerSignal: params.signal,
      retryCount: 0,
    })
    expect(capturedCtx!.recovery).not.toHaveProperty('deadlineMonotonicMs')
  })

  test('keeps caller correlation separate from the internal recovery id', async () => {
    let capturedCtx: Record<string, unknown> | undefined
    const params = {
      ...makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] }),
      requestId: 'internal-unique-id',
      callerRequestId: 'caller-reused-id',
    }
    const config = makeConfig({
      buildStrategyContext: (ctx) => {
        capturedCtx = ctx as Record<string, unknown>
        return { payload: ctx.payload }
      },
    })

    await runPipeline(params, config)

    expect(capturedCtx!.recovery).toEqual({
      requestId: 'internal-unique-id',
      callerRequestId: 'caller-reused-id',
      callerSignal: params.signal,
      retryCount: 0,
    })
  })

  test('rebuilds one exact fallback attempt from pristine post-ingest input', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    config_.modelRewrites = [{ from: 'target', to: 'wrong-target' }]
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source'),
      buildModel('target'),
      buildModel('wrong-target'),
    ))

    interface Context {
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }
    const attempts: SimplePayload[] = []
    const registry = new StrategyRegistry<Context>()
    registry.register({
      name: 'fallback-test',
      canHandle: () => true,
      execute: async ({ payload, recovery }) => {
        attempts.push(structuredClone(payload))
        if (attempts.length === 1) {
          recovery.sourceModel = 'source'
          recovery.retryCount = 1
          throw new TerminalUpstreamRecoveryError(
            new HTTPError(529, {
              error: { message: 'source overloaded', type: 'overloaded_error' },
            }),
            recovery,
          )
        }
        return { kind: 'json', data: { model: 'source', ok: true } }
      },
    })

    const { result, modelMapping } = await runPipeline<SimplePayload, Context>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'original' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        afterTransform({ payload }) {
          payload.messages[0]!.content += '|prepared'
        },
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )

    expect(attempts.map(attempt => attempt.model)).toEqual(['source', 'target'])
    expect(attempts.map(attempt => attempt.messages[0]!.content)).toEqual([
      'original|prepared',
      'original|prepared',
    ])
    expect(modelMapping.steps.at(-1)).toEqual({
      tag: 'OVERLOAD_FALLBACK',
      from: 'source',
      to: 'target',
    })
    expect(result).toEqual({ kind: 'json', data: { model: 'target', ok: true } })
  })

  test('shares one absolute upstream timeout across source and fallback attempts', async () => {
    authStore.upstreamTimeoutSeconds = 60
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))

    interface Context {
      model: string
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      upstreamSignal: Parameters<typeof runStrategy>[1] & { deadlineMonotonicMs: number | null }
    }
    const deadlines: Array<number | null> = []
    let attempts = 0
    const registry = new StrategyRegistry<Context>()
    registry.register({
      name: 'shared-timeout-test',
      canHandle: () => true,
      execute: async ({ model, recovery, upstreamSignal }) => {
        deadlines.push(upstreamSignal.deadlineMonotonicMs)
        attempts++
        return runStrategy({
          execute: async () => {
            if (attempts === 1) {
              recovery.sourceModel = 'source'
              throw new TerminalUpstreamRecoveryError(
                new HTTPError(529, {
                  error: { message: 'source overloaded', type: 'overloaded_error' },
                }),
                recovery,
              )
            }
            return { model }
          },
          isStream: (_result): _result is { model: string } & AsyncIterable<never> => false,
          translateResult: result => result,
          translateStreamChunk: () => null,
        }, upstreamSignal)
      },
    })

    const result = await runPipeline<SimplePayload, Context>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery, upstreamSignal }) => ({
          model: payload.model,
          recovery,
          upstreamSignal,
        }),
      },
    )

    expect(deadlines).toHaveLength(2)
    expect(deadlines[0]).toBe(deadlines[1])
    expect(result.result).toEqual({ kind: 'json', data: { model: 'target' } })
  })

  test('does not fetch the fallback target after the shared upstream deadline expires', async () => {
    authStore.upstreamTimeoutSeconds = 0.001
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))

    interface Context {
      model: string
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      upstreamSignal: Parameters<typeof runStrategy>[1]
    }
    const queue = new UpstreamRequestQueue({ concurrency: 1, maxRetries: 0 })
    let sourceError: TerminalUpstreamRecoveryError | undefined
    let fallbackAttempts = 0
    let targetFetches = 0
    const registry = new StrategyRegistry<Context>()
    registry.register({
      name: 'expired-fallback-deadline',
      canHandle: () => true,
      execute: async ({ model, recovery, upstreamSignal }) => {
        if (model === 'source') {
          await Bun.sleep(10)
          recovery.sourceModel = 'source'
          sourceError = new TerminalUpstreamRecoveryError(
            new HTTPError(529, {
              error: { message: 'source overloaded', type: 'overloaded_error' },
            }),
            recovery,
          )
          throw sourceError
        }

        fallbackAttempts++
        await queue.dispatch(
          () => {
            targetFetches++
            return Promise.resolve(Response.json({ ok: true }))
          },
          {
            url: 'https://api.githubcopilot.com/chat/completions',
            effectiveModel: 'target',
            fallbackAttempt: true,
            recovery,
          },
          upstreamSignal.signal,
        )
        throw new Error('unreachable')
      },
    })

    const thrown = await runPipeline<SimplePayload, Context>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery, upstreamSignal }) => ({
          model: payload.model,
          recovery,
          upstreamSignal,
        }),
      },
    ).then(() => undefined, error => error)

    expect(thrown).toBe(sourceError)
    expect(fallbackAttempts).toBe(1)
    expect(targetFetches).toBe(0)
    expect(sourceError?.status).toBe(529)
    expect(sourceError?.recovery.fallbackFetchStarted).toBeFalse()
  })

  test('does not fallback for an unconfigured or non-529 terminal outcome', async () => {
    const cases = [
      { name: 'unconfigured 529', status: 529, configured: false },
      { name: 'configured 429', status: 429, configured: true },
    ] as const

    for (const scenario of cases) {
      const config_ = getCachedConfig() as Record<string, unknown>
      config_.overloadFallbacks = scenario.configured ? { source: 'target' } : undefined
      modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))
      let attempts = 0
      const registry = new StrategyRegistry<{
        payload: SimplePayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>()
      const sourceError = new HTTPError(scenario.status, {
        error: { message: scenario.name, type: 'overloaded_error' },
      })
      registry.register({
        name: 'terminal-test',
        canHandle: () => true,
        execute: async ({ recovery }) => {
          attempts++
          recovery.sourceModel = 'source'
          throw new TerminalUpstreamRecoveryError(sourceError, recovery)
        },
      })

      await expect(runPipeline<SimplePayload, {
        payload: SimplePayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>(
        makeParams({ model: 'source', messages: [{ role: 'user', content: 'original' }] }),
        {
          protocol: 'openai-chat',
          strategyRegistry: registry,
          buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
        },
      )).rejects.toMatchObject({ status: scenario.status })
      expect(attempts).toBe(1)
    }
  })

  test('uses a valid local-cooldown handoff without resuming the source', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))
    let attempts = 0
    const registry = new StrategyRegistry<{
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'local-cooldown-test',
      canHandle: () => true,
      execute: async ({ recovery }) => {
        attempts++
        if (attempts === 1) {
          recovery.sourceModel = 'source'
          throw new LocalModelCooldownError(recovery, '3')
        }
        return { kind: 'json', data: { model: 'target' } }
      },
    })

    const { result } = await runPipeline<SimplePayload, {
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )

    expect(result).toEqual({ kind: 'json', data: { model: 'target' } })
    expect(attempts).toBe(2)
  })

  test('surfaces the target error without retrying or chaining fallback', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target', target: 'third' }
    modelCache.cacheModels(buildModelsResponse(
      buildModel('source'),
      buildModel('target'),
      buildModel('third'),
    ))
    const targetError = new HTTPError(429, {
      error: { message: 'target limited', type: 'rate_limit_error' },
    })
    const queue = new UpstreamRequestQueue({ concurrency: 1, maxRetries: 0 })
    let targetFetches = 0
    let attempts = 0
    const registry = new StrategyRegistry<{
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'target-failure-test',
      canHandle: () => true,
      execute: async ({ recovery }) => {
        attempts++
        if (attempts === 1) {
          recovery.sourceModel = 'source'
          throw new TerminalUpstreamRecoveryError(
            new HTTPError(529, {
              error: { message: 'source overloaded', type: 'overloaded_error' },
            }),
            recovery,
          )
        }
        await queue.dispatch(
          async () => {
            targetFetches++
            throw targetError
          },
          {
            url: 'https://api.githubcopilot.com/chat/completions',
            effectiveModel: 'target',
            fallbackAttempt: true,
            recovery,
          },
        )
        throw new Error('unreachable')
      },
    })

    await expect(runPipeline<SimplePayload, {
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )).rejects.toBe(targetError)
    expect(attempts).toBe(2)
    expect(targetFetches).toBe(1)
  })

  test('preserves the source error when target execution fails before fetch', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))
    const sourceError = new TerminalUpstreamRecoveryError(
      new HTTPError(529, {
        error: { message: 'source overloaded', type: 'overloaded_error' },
      }, { headers: { 'retry-after': '3' } }),
      { requestId: 'pre-fetch-failure', retryCount: 1, sourceModel: 'source' },
    )
    let attempts = 0
    const registry = new StrategyRegistry<{
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'pre-fetch-failure-test',
      canHandle: () => true,
      execute: async () => {
        attempts++
        if (attempts === 1)
          throw sourceError
        throw new HTTPError(400, {
          error: { message: 'target translation rejected', type: 'translation_error' },
        })
      },
    })

    await expect(runPipeline<SimplePayload, {
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )).rejects.toBe(sourceError)
    expect(attempts).toBe(2)
    expect(sourceError.recovery.fallbackFetchStarted).toBeFalse()
  })

  test('cleans the fallback upstream signal when target preflight rejects', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))

    const listeners = new Set<unknown>()
    const clientSignal = {
      aborted: false,
      addEventListener(_type: string, listener: unknown) {
        listeners.add(listener)
      },
      removeEventListener(_type: string, listener: unknown) {
        listeners.delete(listener)
      },
      throwIfAborted() {},
    } as unknown as AbortSignal
    const sourceError = new TerminalUpstreamRecoveryError(
      new HTTPError(529, {
        error: { message: 'source overloaded', type: 'overloaded_error' },
      }),
      { requestId: 'preflight-cleanup', retryCount: 1, sourceModel: 'source' },
    )

    interface Context {
      model: string
      upstreamSignal: Parameters<typeof runStrategy>[1]
    }
    const registry = new StrategyRegistry<Context>()
    registry.register({
      name: 'source',
      canHandle: model => model?.id === 'source',
      execute: ({ upstreamSignal }) => runStrategy({
        execute: async () => {
          throw sourceError
        },
        isStream: (_result): _result is never => false,
        translateResult: result => result,
        translateStreamChunk: () => null,
      }, upstreamSignal),
    })
    registry.register({
      name: 'target-preflight',
      canHandle: () => true,
      execute: async () => {
        throw new HTTPError(400, {
          error: { message: 'target translation rejected', type: 'translation_error' },
        })
      },
    })

    await expect(runPipeline<SimplePayload, Context>(
      {
        ...makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
        signal: clientSignal,
      },
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, upstreamSignal }) => ({
          model: payload.model,
          upstreamSignal,
        }),
      },
    )).rejects.toBe(sourceError)
    expect(listeners.size).toBe(0)
  })

  test('fallback events retain production queue metrics for every decision', async () => {
    const originalInfo = consola.info
    const events: RecoveryEvent[] = []
    consola.info = ((message: unknown, fields: unknown) => {
      if (message === 'Upstream recovery')
        events.push(fields as RecoveryEvent)
    }) as typeof consola.info

    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))
    const outcomes = [
      'succeeded',
      'pre-fetch-failed',
      'target-cooldown',
      'target-failed',
    ] as const

    try {
      for (const outcome of outcomes) {
        events.length = 0
        const queue = new UpstreamRequestQueue({
          concurrency: 2,
          maxRetries: 0,
        })
        let sourceError: TerminalUpstreamRecoveryError | undefined
        const targetError = new HTTPError(429, {
          error: { message: 'target limited', type: 'rate_limit_error' },
        })

        interface Context {
          model: string
          recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
          upstreamSignal: Parameters<typeof runStrategy>[1]
        }
        const registry = new StrategyRegistry<Context>()
        registry.register({
          name: `fallback-log-${outcome}`,
          canHandle: () => true,
          execute: async ({ model, recovery, upstreamSignal }) => {
            if (model === 'source') {
              const queued = await queue.dispatch(
                () => Promise.resolve(new Response('overloaded', { status: 529 })),
                {
                  url: 'https://api.githubcopilot.com/chat/completions',
                  effectiveModel: 'source',
                  retryable: 'capacity',
                  recovery,
                },
                upstreamSignal.signal,
              )
              queued.release()
              sourceError = new TerminalUpstreamRecoveryError(
                new HTTPError(529, {
                  error: { message: 'source overloaded', type: 'overloaded_error' },
                }),
                recovery,
              )
              throw sourceError
            }

            if (outcome === 'succeeded') {
              upstreamSignal.cleanup()
              return { kind: 'json', data: { model: 'target' } }
            }
            if (outcome === 'pre-fetch-failed') {
              throw new HTTPError(400, {
                error: { message: 'target rejected', type: 'translation_error' },
              })
            }
            if (outcome === 'target-cooldown') {
              throw new FallbackCooldownError({
                scope: 'model',
                effectiveModel: 'target',
                notBeforeMonotonicMs: performance.now() + 1_000,
              })
            }

            await queue.dispatch(
              async () => {
                throw targetError
              },
              {
                url: 'https://api.githubcopilot.com/chat/completions',
                effectiveModel: 'target',
                fallbackAttempt: true,
                recovery,
              },
              upstreamSignal.signal,
            )
            throw new Error('unreachable')
          },
        })

        const thrown = await runPipeline<SimplePayload, Context>(
          makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
          {
            protocol: 'openai-chat',
            strategyRegistry: registry,
            buildStrategyContext: ({ payload, recovery, upstreamSignal }) => ({
              model: payload.model,
              recovery,
              upstreamSignal,
            }),
          },
        ).then(() => undefined, error => error)

        if (outcome === 'succeeded')
          expect(thrown).toBeUndefined()
        else if (outcome === 'target-failed')
          expect(thrown).toBe(targetError)
        else
          expect(thrown).toBe(sourceError)

        const fallbackEvents = events.filter(event => event.event === 'fallback')
        expect(fallbackEvents.map(event => event.decision)).toEqual(['selected', outcome])
        for (const event of fallbackEvents) {
          expect(event).toMatchObject({
            activeSlots: expect.any(Number),
            maxSlots: 2,
            pendingDepth: expect.any(Number),
            maxPendingDepth: 1_000,
          })
        }
      }
    }
    finally {
      consola.info = originalInfo
    }
  })

  test('rejects fallback targets missing an explicitly requested capability', async () => {
    const target = buildModel('target')
    target.capabilities.supports.tool_calls = false
    target.capabilities.supports.vision = false
    target.capabilities.supports.adaptive_thinking = false
    target.capabilities.supports.reasoning_effort = undefined
    target.capabilities.supports.structured_outputs = false
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), target))
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }

    const base: ChatCompletionsPayload = {
      model: 'source',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const cases: Array<{ name: string, payload: ChatCompletionsPayload }> = [
      {
        name: 'tools',
        payload: {
          ...base,
          tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
        },
      },
      {
        name: 'vision',
        payload: {
          ...base,
          messages: [{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
          }],
        },
      },
      { name: 'reasoning', payload: { ...base, reasoning_effort: 'high' } },
      { name: 'structured output', payload: { ...base, response_format: { type: 'json_object' } } },
    ]

    for (const scenario of cases) {
      let attempts = 0
      const sourceError = new HTTPError(529, {
        error: { message: scenario.name, type: 'overloaded_error' },
      })
      const registry = new StrategyRegistry<{
        payload: ChatCompletionsPayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>()
      registry.register({
        name: 'capability-test',
        canHandle: () => true,
        execute: async ({ recovery }) => {
          attempts++
          recovery.sourceModel = 'source'
          throw new TerminalUpstreamRecoveryError(sourceError, recovery)
        },
      })

      await expect(runPipeline<ChatCompletionsPayload, {
        payload: ChatCompletionsPayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>(
        makeParams(scenario.payload as unknown as SimplePayload),
        {
          protocol: 'openai-chat',
          strategyRegistry: registry,
          buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
        },
      )).rejects.toMatchObject({ status: 529, body: sourceError.body })
      expect(attempts).toBe(1)
    }
  })

  test('does not require capabilities that the request explicitly disables', async () => {
    const target = buildModel('target')
    target.capabilities.supports.reasoning_effort = undefined
    target.capabilities.supports.structured_outputs = false
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), target))
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    const cases: Array<ChatCompletionsPayload> = [{
      model: 'source',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    }]

    for (const payload of cases) {
      let attempts = 0
      const registry = new StrategyRegistry<{
        payload: ChatCompletionsPayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>()
      registry.register({
        name: 'disabled-capability-test',
        canHandle: () => true,
        execute: async ({ recovery }) => {
          attempts++
          if (attempts === 1) {
            recovery.sourceModel = 'source'
            throw new TerminalUpstreamRecoveryError(
              new HTTPError(529, {
                error: { message: 'source overloaded', type: 'overloaded_error' },
              }),
              recovery,
            )
          }
          return { kind: 'json', data: { model: 'target' } }
        },
      })

      await expect(runPipeline<ChatCompletionsPayload, {
        payload: ChatCompletionsPayload
        recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
      }>(
        makeParams(payload as unknown as SimplePayload),
        {
          protocol: 'openai-chat',
          strategyRegistry: registry,
          buildStrategyContext: ({ payload: attemptPayload, recovery }) => ({
            payload: attemptPayload,
            recovery,
          }),
        },
      )).resolves.toMatchObject({
        result: { kind: 'json', data: { model: 'target' } },
      })
      expect(attempts).toBe(2)
    }
  })

  test('rejects a target that cannot preserve requested parallel tool calls', async () => {
    const target = buildModel('target')
    target.capabilities.supports.tool_calls = true
    target.capabilities.supports.parallel_tool_calls = false
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), target))
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    let attempts = 0
    const registry = new StrategyRegistry<{
      payload: ChatCompletionsPayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'parallel-tools-test',
      canHandle: () => true,
      execute: async ({ recovery }) => {
        attempts++
        recovery.sourceModel = 'source'
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }),
          recovery,
        )
      },
    })

    await expect(runPipeline<ChatCompletionsPayload, {
      payload: ChatCompletionsPayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      makeParams({
        model: 'source',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
        parallel_tool_calls: true,
      } as unknown as SimplePayload),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )).rejects.toMatchObject({ status: 529 })
    expect(attempts).toBe(1)
  })

  test('rejects a target that explicitly does not support streaming', async () => {
    const target = buildModel('target')
    target.capabilities.supports.streaming = false
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), target))
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    let attempts = 0
    const registry = new StrategyRegistry<{
      payload: ChatCompletionsPayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'streaming-capability-test',
      canHandle: () => true,
      execute: async ({ recovery }) => {
        attempts++
        recovery.sourceModel = 'source'
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }),
          recovery,
        )
      },
    })

    await expect(runPipeline<ChatCompletionsPayload, {
      payload: ChatCompletionsPayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      makeParams({
        model: 'source',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      } as unknown as SimplePayload),
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )).rejects.toMatchObject({ status: 529 })
    expect(attempts).toBe(1)
  })

  test('does not execute fallback after caller aborts during target preparation', async () => {
    const config_ = getCachedConfig() as Record<string, unknown>
    config_.overloadFallbacks = { source: 'target' }
    modelCache.cacheModels(buildModelsResponse(buildModel('source'), buildModel('target')))
    const controller = new AbortController()
    const params = {
      ...makeParams({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    }
    let attempts = 0
    let transforms = 0
    const registry = new StrategyRegistry<{
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>()
    registry.register({
      name: 'abort-during-prepare-test',
      canHandle: () => true,
      execute: async ({ recovery }) => {
        attempts++
        recovery.sourceModel = 'source'
        throw new TerminalUpstreamRecoveryError(
          new HTTPError(529, {
            error: { message: 'source overloaded', type: 'overloaded_error' },
          }),
          recovery,
        )
      },
    })

    await expect(runPipeline<SimplePayload, {
      payload: SimplePayload
      recovery: ConstructorParameters<typeof TerminalUpstreamRecoveryError>[1]
    }>(
      params,
      {
        protocol: 'openai-chat',
        strategyRegistry: registry,
        afterTransform() {
          transforms++
          if (transforms === 2)
            controller.abort('caller gone')
        },
        buildStrategyContext: ({ payload, recovery }) => ({ payload, recovery }),
      },
    )).rejects.toBe('caller gone')
    expect(attempts).toBe(1)
  })
})
