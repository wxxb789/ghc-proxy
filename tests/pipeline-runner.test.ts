import type { ExecutionResult } from '~/lib/execution-strategy'
import type { IngestContext, PipelineConfig, TransformContext } from '~/pipeline/runner'
import type { ModelTransformChain } from '~/transform'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { StrategyRegistry } from '~/dispatch'
import { runPipeline } from '~/pipeline/runner'
import {
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

const originalState = saveStateSnapshot()

beforeEach(() => {
  setupDefaultTestState()
})

afterEach(() => {
  restoreStateSnapshot(originalState)
})

// ── Helpers ──

function noopTransformChain(): ModelTransformChain {
  return {
    apply: input => ({
      model: input.model,
      resolvedModel: undefined,
      trace: [],
    }),
  }
}

function rewriteTransformChain(fromModel: string, toModel: string): ModelTransformChain {
  return {
    apply: (input) => {
      if (input.model === fromModel) {
        return {
          model: toModel,
          resolvedModel: undefined,
          trace: [{ tag: 'CONFIG_REWRITE', from: fromModel, to: toModel }],
        }
      }
      return { model: input.model, resolvedModel: undefined, trace: [] }
    },
  }
}

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

function makeParams(body: SimplePayload): { body: SimplePayload, signal: AbortSignal, headers: Headers } {
  return {
    body,
    signal: new AbortController().signal,
    headers: new Headers({ 'content-type': 'application/json' }),
  }
}

function makeConfig(
  overrides: Partial<PipelineConfig<SimplePayload, { payload: SimplePayload }>> = {},
): PipelineConfig<SimplePayload, { payload: SimplePayload }> {
  return {
    protocol: 'openai-chat',
    transformChain: noopTransformChain(),
    strategyRegistry: makeStrategyRegistry(),
    buildStrategyContext: ({ payload }) => ({ payload }),
    ...overrides,
  }
}

describe('runPipeline', () => {
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

  test('transform chain rewrite is reflected in model mapping trace', async () => {
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
      transformChain: rewriteTransformChain('old-model', 'new-model'),
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

  test('afterTransform hook is called with transform result', async () => {
    const captured: TransformContext<SimplePayload>[] = []
    const params = makeParams({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'test' }] })

    const config = makeConfig({
      transformChain: rewriteTransformChain('claude-sonnet-4.5', 'claude-opus-4.6'),
      afterTransform: (ctx) => {
        captured.push(ctx)
      },
    })

    await runPipeline(params, config)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.transformResult.model).toBe('claude-opus-4.6')
    expect(captured[0]!.transformResult.trace).toHaveLength(1)
    expect(captured[0]!.payload.model).toBe('claude-opus-4.6')
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
      transformChain: noopTransformChain(),
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
  })
})
